import { A, If, Loop, axes, quat, vector, copy, add, sub, scale, cross, dot, rotate, multiply, normalize, choose, dispatch } from "./expression.mjs";
import { terrainValue, MAX_TERRAIN_BOXES } from './input.mjs';
import { materialValue, inverseMass, inverseInertia } from './control.mjs';
import { hingeFrame, nearestAngle } from './hinge.mjs';

export function createDynamics(rig, settings) {
const { bodies: BODIES, joints: JOINTS, shapes: SHAPES, shapePairs: SHAPE_PAIRS } = rig;
const CONTACT_LIMIT = settings.contactLimit;
const GROUND = BODIES.length;
const NATIVE_GROUND = GROUND + MAX_TERRAIN_BOXES;
const dt = 1 / settings.frequency;
const gravityValue = (factor = 1) => factor === 1 ? 'v.gravity_pixels' : 'v.gravity_step';
const ITERATIONS = settings.iterations;
const hasHinges=JOINTS.some(j=>j.hinge!==0);
const jointRows=hasHinges?7:5;
const slots = Array.from({ length: CONTACT_LIMIT }, (_, i) => i);
const parts = [...BODIES, null];
const contactKeys = ["g", "lo", "hi", ...["n", "ra", "rb"].flatMap(p => axes.map(k => p + k))];
const pagedContacts=CONTACT_LIMIT>128;
const solvedContact=(i,k)=>pagedContacts?`v.contact_sorted_${i}_${k}`:`v.c${i}.${k}`;
const bodyKeys = ["im", ...["v", "w", "dv", "dw"].flatMap(p => axes.map(k => p + k)), ...axes.flatMap(k => axes.map(l => "i" + k + l))];
const loadBody = (out,index) => dispatch(index,parts,(_,i)=>bodyKeys.filter(k=>!['iyx','izx','izy'].includes(k)).map(k=>A(out+k,'v.d'+i+'.'+k)));
const saveDelta = (out,index) => dispatch(index,parts,(_,i)=>['dv','dw'].flatMap(p=>axes.map(k=>A('v.d'+i+'.'+p+k,out+p+k))));
const matrix = (out, body, p) => axes.map(k => A(out + k, axes.map(l => `${body}i${[k,l].sort().join('')}*${p}${l}`).join("+")));
const basis = (out, q) => axes.map((_, i) => [vector("t.unit", axes.map((_, j) => Number(i === j))), rotate(out + i, q, "t.unit")]);
const shapeKeys = [...axes, ...quat.map(k => "q" + k), ...axes.map(k => "h" + k), "body"];
const shapeIndices = SHAPES.map((_,i)=>i);
const loadShape=(out,index,indices=shapeIndices)=>[
  ...axes.map((k,j)=>A(out+'h'+k,choose(index,indices.map(i=>SHAPES[i].half[j])))),
  dispatch(index,indices,i=>shapeKeys.filter(k=>k[0]!=='h').map(k=>A(out+k,k==='body'?SHAPES[i].body:'v.s'+i+'.'+k))),
];
const swapShapes = () => [shapeKeys.map(k=>A("t.swap"+k,"t.a"+k)),shapeKeys.map(k=>A("t.a"+k,"t.b"+k)),shapeKeys.map(k=>A("t.b"+k,"t.swap"+k))];

function initializeDynamics() {
  return [A("v.contact_count", 0), A("v.contact_overflow", 0),
    vector(`v.d${GROUND}.`, [0, 0, 0]),
    parts.flatMap((_, i) => bodyKeys.map(k => A(`v.d${i}.${k}`, 0))),
    [...contactKeys,'l0','l1','l2'].map(k=>A('v.scratch_zero.'+k,0)),slots.map(i=>A('v.c'+i,'v.scratch_zero')),
    pagedContacts?slots.map(i=>[...contactKeys,'l0','l1','l2'].map(k=>A(solvedContact(i,k),0))):[],
    JOINTS.flatMap((_, i) => Array.from({ length: jointRows }, (_, k) => A(`v.j${i}l${k}`, 0))),
  ];
}

function prepareBodies() {
  const sel=(values)=>choose('t.body_index',values);
  const b='v.scratch_b.',d='v.scratch_d.',s='v.scratch_s.';
  return [A('v.contact_count',0),A('v.contact_overflow',0),A('v.support',0),
    
    A('t.body_index',0),Loop(BODIES.length,[
      A('v.scratch_b',sel(BODIES.map((_,i)=>'v.b'+i))),
      A('v.scratch_d',sel(BODIES.map((_,i)=>'v.d'+i))),
      scale(d,b,16),scale(d+'v',b+'v',16),copy(d+'w',b+'w'),vector(d+'dv',[0,0,0]),vector(d+'dw',[0,0,0]),
      A(d+'im',sel(BODIES.map((_,i)=>inverseMass(rig,i)))),basis('t.u',b+'q'),
      ...[0,1,2].map(j=>A('t.inverse_inertia'+j,sel(BODIES.map((_,i)=>inverseInertia(rig,i,j))))),
      axes.flatMap(k=>axes.map(l=>A(d+'i'+k+l,axes.map((_,j)=>'t.u'+j+k+'*t.u'+j+l+'*t.inverse_inertia'+j).join('+')))),
      dispatch('t.body_index',BODIES,(_,i)=>A('v.d'+i,'v.scratch_d')),A('t.body_index','t.body_index+1'),
    ]),
    A('t.shape_index',0),Loop(SHAPES.length,[
      A('v.scratch_s',0),
      ...axes.map((k,j)=>A('t.local'+k,choose('t.shape_index',SHAPES.map(shape=>shape.center[j])))),
      A('t.shape_body',choose('t.shape_index',SHAPES.map(shape=>shape.body))),
      A('v.scratch_b',choose('t.shape_body',BODIES.map((_,i)=>'v.b'+i))),
      A('v.scratch_d',choose('t.shape_body',BODIES.map((_,i)=>'v.d'+i))),
      rotate('t.offset',b+'q','t.local'),add(s,'v.scratch_d.','t.offset'),
      ...quat.map((k,j)=>A('t.localq'+k,choose('t.shape_index',SHAPES.map(shape=>shape.quaternion[j])))),
      multiply(s+'q',b+'q','t.localq'),
      ...axes.map((k,j)=>A(s+'h'+k,choose('t.shape_index',SHAPES.map(shape=>shape.half[j])))),A(s+'body','t.shape_body'),
      dispatch('t.shape_index',SHAPES,(_,i)=>A('v.s'+i,'v.scratch_s')),A('t.shape_index','t.shape_index+1'),
    ]),
    A('t.shape_index',0),Loop(SHAPES.length,[
      A('v.scratch_s',choose('t.shape_index',SHAPES.map((_,i)=>'v.s'+i))),basis('t.u',s+'q'),
      axes.map(k=>A(s+'e'+k,axes.map((l,j)=>'math.abs(t.u'+j+k+')*'+s+'h'+l).join('+'))),
      dispatch('t.shape_index',SHAPES,(_,i)=>A('v.s'+i,'v.scratch_s')),A('t.shape_index','t.shape_index+1'),
    ]),
    BODIES.map((_,i)=>A('v.d'+i+'.minx',SHAPES.flatMap((s,j)=>s.body===i?['(v.s'+j+'.x-v.s'+j+'.ex)']:[]).reduce((a,b)=>'math.min('+a+','+b+')'))),
    JOINTS.flatMap((_,i)=>Array.from({length:jointRows},(_,k)=>A('v.j'+i+'l'+k,0))),
  ];
}
function appendContact() {
  return [A("t.clo","t.sort_lo"),A("t.chi","t.sort_hi"),If(`v.contact_count<${CONTACT_LIMIT}`, [
    dispatch('v.contact_count',slots,i=>[...contactKeys.map(k=>A('v.c'+i+'.'+k,'t.c'+k)),...(pagedContacts?[]:[0,1,2].map(k=>A('v.c'+i+'.l'+k,0)))]),
    A("v.contact_count", "v.contact_count+1"), If(`t.cia==${GROUND} || t.cib==${GROUND}`, A("v.support", 1)),
  ], A("v.contact_overflow", 1))];
}
const vertices = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const faces = [[3,2,1,0],[4,5,6,7],[5,4,0,1],[2,3,7,6],[0,4,7,3],[1,2,6,5]];
const faceAxis = [2,2,1,1,0,0], faceSign = [-1,1,-1,1,-1,1];
const polygon = Array.from({ length: 8 }, (_, i) => i);
function appendVertex() {
  return [dispatch("t.out_count", polygon, i => copy("t.out" + i, "t.vertex")), A("t.out_count", "t.out_count+1")];
}
function collide() {
  const extent = side => axes.map((k, i) => `t.${side}h${k}*math.abs(${dot(`t.${side}u${i}`, "t.axis")})`).join("+");
  const faceNormal = side => [axes.map(k => A("t.fn" + k, `(${choose(`t.${side}face`, faceAxis.map(i => `t.${side}u${i}${k}`))})*(${choose(`t.${side}face`, faceSign)})`))];
  return [basis("t.au", "t.aq"), basis("t.bu", "t.bq"), sub("t.delta", "t.b", "t.a"),
    A("t.depth", 1e6), A("t.axis_id", 0), Loop(15, [If("t.depth>=0", [
      If("t.axis_id<6", axes.map(k => A("t.axis" + k, choose("t.axis_id", [0,1,2].map(i => `t.au${i}${k}`).concat([0,1,2].map(i => `t.bu${i}${k}`))))), [
        axes.map(k => A("t.u" + k, choose("math.floor((t.axis_id-6)/3)", [0,1,2].map(i => `t.au${i}${k}`)))),
        axes.map(k => A("t.w" + k, choose("math.mod(t.axis_id,3)", [0,1,2].map(i => `t.bu${i}${k}`)))), cross("t.axis", "t.u", "t.w"),
      ]), A("t.norm_axis", `math.sqrt(${dot("t.axis", "t.axis")})`),
      If("t.norm_axis>0.000001", [scale("t.axis", "t.axis", "1/t.norm_axis"), A("t.projection", dot("t.delta", "t.axis")),
        A("t.overlap", `${extent("a")}+${extent("b")}-math.abs(t.projection)`),
        If("t.overlap<t.depth", [A("t.depth", "t.overlap"), scale("t.normal", "t.axis", "t.projection<0?-1:1")]),
      ]),
    ]), A("t.axis_id", "t.axis_id+1")]),
    If("t.depth>=0", [
      ...["a", "b"].map(side => [A(`t.${side}face`, 0), A("t.best", -1e6),
        faces.map((_, i) => [A("t.projection", `(${dot(`t.${side}u${faceAxis[i]}`, "t.normal")})*${faceSign[i] * (side === "a" ? 1 : -1)}`),
          If("t.projection>t.best", [A("t.best", "t.projection"), A(`t.${side}face`, i)])]),
      ]),
      faceNormal("a"), copy("t.reference", "t.fn"), A("t.reference_half", choose("t.aface", faceAxis.map(i => "t.ah" + axes[i]))),
      A("t.count", 4), [0,1,2,3].map(j => [
        vector("t.local", axes.map((k, i) => `t.bh${k}*(${choose("t.bface", faces.map(f => vertices[f[j]][i]))})`)),
        rotate("t.vertex", "t.bq", "t.local"), add("t.vertex", "t.vertex", "t.b"), copy("t.poly" + j, "t.vertex"),
      ]),
      [A('t.clip_face',0),Loop(6,[If(choose('t.aface',faceAxis)+'!='+choose('t.clip_face',faceAxis)+'&&t.count>0', [
        vector('t.plane',axes.map(k=>'('+choose('t.clip_face',faceAxis.map(i=>'t.au'+i+k))+')*('+choose('t.clip_face',faceSign)+')')),A('t.plane_half',choose('t.clip_face',faceAxis.map(i=>'t.ah'+axes[i]))),
        A("t.out_count", 0), axes.map(k => A("t.start" + k, choose("t.count-1", polygon.map(i => `t.poly${i}${k}`)))),
        sub("t.rel", "t.start", "t.a"), A("t.distance_start", `(${dot("t.plane", "t.rel")})-t.plane_half`),
        A("t.vertex_id", 0), Loop("t.count", [
          axes.map(k => A("t.end" + k, choose("t.vertex_id", polygon.map(i => `t.poly${i}${k}`)))),
          sub("t.rel", "t.end", "t.a"), A("t.distance_end", `(${dot("t.plane", "t.rel")})-t.plane_half`),
          If("(t.distance_start<0)!=(t.distance_end<0)", [
            A("t.fraction", "t.distance_start/(t.distance_start-t.distance_end)"),
            axes.map(k => A("t.vertex" + k, `t.start${k}+(t.end${k}-t.start${k})*t.fraction`)), appendVertex(),
          ]), If("t.distance_end<0", [copy("t.vertex", "t.end"), appendVertex()]),
          copy("t.start", "t.end"), A("t.distance_start", "t.distance_end"), A("t.vertex_id", "t.vertex_id+1"),
        ]), A("t.count", "t.out_count"), polygon.map(i => If(`t.count>${i}`, copy("t.poly" + i, "t.out" + i))),
      ]),A('t.clip_face','t.clip_face+1')])],
      A("t.vertex_id", 0), Loop("t.count", [
        axes.map(k => A("t.point" + k, choose("t.vertex_id", polygon.map(i => `t.poly${i}${k}`)))), sub("t.rel", "t.point", "t.a"),
        A("t.distance", `(${dot("t.reference", "t.rel")})-t.reference_half`),
        If("t.distance<=0.000001", [
          A("t.cia", "t.abody"), A("t.cib", "t.bbody"), copy("t.cn", "t.normal"),
          A("t.cg", `t.distance*(${dot("t.normal", "t.reference")})`),
          axes.map(k => A("t.cra" + k, `t.point${k}-t.reference${k}*t.distance-(${choose("t.abody", parts.map((_, i) => `v.d${i}.${k}`))})`)),
          axes.map(k => A("t.crb" + k, `t.point${k}-(${choose("t.bbody", parts.map((_, i) => `v.d${i}.${k}`))})`)), appendContact(),
        ]), A("t.vertex_id", "t.vertex_id+1"),
      ]),
    ]),
  ];
}
function terrainShape() {
  return [If('t.terrain_external', [
    A('t.box_index', `t.cell_id-${GROUND}`),
    dispatch('t.box_index', Array.from({length:MAX_TERRAIN_BOXES},(_,i)=>i), i => axes.flatMap(k => [A('t.box_min'+k,`v.external_terrain_${i}_min${k}`),A('t.box_max'+k,`v.external_terrain_${i}_max${k}`)])),
    ...axes.flatMap(k => [
      A('t.b' + k, `(t.box_min${k}+(t.box_max${k}-t.box_min${k})*0.5-v.o${k})*16`), A('t.bh' + k, `(t.box_max${k}-t.box_min${k})*8`)]),
  ], [axes.map(k => A('t.b' + k, `(t.cell${k}+0.5-v.o${k})*16`)), vector('t.bh', [8,8,8])])];
}
const outsideTerrain = prefix => axes.map(k=>`${prefix}${k}<v.ragdoll_terrain_bounds_min${k}||${prefix}${k}>=v.ragdoll_terrain_bounds_max${k}`).join('||');
function terrainCell(solid) {
  return [A('t.solid','t.terrain_external'),If('!t.terrain_external',[
    If('v.ragdoll_terrain_mode!=2||'+outsideTerrain('t.cell'),A('t.solid',solid)),
  ])];
}
function contacts() {
  const at='t.cellx-math.floor(v.ex),t.celly-math.floor(v.ey),t.cellz-math.floor(v.ez)';
  const tags=values=>values.map(value=>"'"+value+"'").join(',');
  const solid='q.relative_block_has_any_tag('+at+','+tags(settings.terrain.includeTags)+')'+(settings.terrain.excludeTags.length?'&&!q.relative_block_has_any_tag('+at+','+tags(settings.terrain.excludeTags)+')':'');
  return [
    vector('t.min',[1e6,1e6,1e6]),vector('t.max',[-1e6,-1e6,-1e6]),
    SHAPES.map((_,i)=>axes.flatMap(k=>[A('t.min'+k,'math.min(t.min'+k+',v.s'+i+k+'-v.s'+i+'e'+k+')'),A('t.max'+k,'math.max(t.max'+k+',v.s'+i+k+'+v.s'+i+'e'+k+')')])),
    axes.flatMap(k=>[A('t.min'+k,'math.floor(v.o'+k+'+t.min'+k+'/16)'),A('t.max'+k,'math.floor(v.o'+k+'+t.max'+k+'/16)')]),
    A('v.terrain_minx','t.minx'),A('v.terrain_yz','(t.maxy-t.miny+1)*(t.maxz-t.minz+1)'),
    A('t.contact_mode',SHAPE_PAIRS.length?0:1),Loop(`(v.ragdoll_terrain_mode==2?1:0)+${SHAPE_PAIRS.length?2:1}`,[
      A('t.terrain_external','t.contact_mode==1&&v.ragdoll_terrain_mode>0'),
      A('t.pair',0),A('t.cell_id',`t.terrain_external?${GROUND}:${NATIVE_GROUND}`),A('t.cellx','t.minx'),Loop(`t.contact_mode?(t.terrain_external?math.clamp(v.ragdoll_terrain_count,0,${MAX_TERRAIN_BOXES}):t.maxx-t.minx+1):1`,[
        A('t.celly','t.miny'),Loop('t.contact_mode&&!t.terrain_external?t.maxy-t.miny+1:1',[
          A('t.cellz','t.minz'),Loop('t.contact_mode?(t.terrain_external?1:t.maxz-t.minz+1):'+SHAPE_PAIRS.length,[
            If('t.contact_mode',terrainCell(solid),A('t.solid','v.simulation_collisions')),
            If('t.solid',[
              A('t.shape',0),Loop('t.contact_mode?'+SHAPES.length+':1',[
                A('t.do_contact',1),
                If('!t.contact_mode',SHAPE_PAIRS.length?[
                  A('t.shape_a',choose('t.pair',SHAPE_PAIRS.map(p=>p[0]))),A('t.shape_b',choose('t.pair',SHAPE_PAIRS.map(p=>p[1]))),
                  loadShape('t.a','t.shape_a'),loadShape('t.b','t.shape_b'),
                  A('t.bound_a',choose('t.abody',BODIES.map((_,i)=>'v.d'+i+'.minx'))),A('t.bound_b',choose('t.bbody',BODIES.map((_,i)=>'v.d'+i+'.minx'))),
                  If('t.bound_a<t.bound_b||(t.bound_a==t.bound_b&&t.abody<t.bbody)',[
                    A('t.sort_lox','t.bound_a'),A('t.sort_lo','t.abody'),A('t.sort_hix','t.bound_b'),A('t.sort_hi','t.bbody'),swapShapes(),
                  ],[A('t.sort_lox','t.bound_b'),A('t.sort_lo','t.bbody'),A('t.sort_hix','t.bound_a'),A('t.sort_hi','t.abody')]),
                ]:[],[
                  loadShape('t.a','t.shape'),terrainShape(),
                  basis('t.au','t.aq'),
                  A('t.do_contact',axes.map(k=>'math.abs(t.a'+k+'-t.b'+k+')<=t.bh'+k+'+('+axes.map((l,j)=>'math.abs(t.au'+j+k+')*t.ah'+l).join('+')+')').join('&&')),
                  If('t.do_contact',[
                    vector('t.bq',[0,0,0]),A('t.bqw',1),A('t.bbody',GROUND),
                    A('t.body_minx',choose('t.abody',BODIES.map((_,i)=>'v.d'+i+'.minx'))),A('t.cell_minx','t.bx-t.bhx'),
                    If('t.cell_minx<t.body_minx',[A('t.sort_lox','t.cell_minx'),A('t.sort_lo','t.cell_id'),A('t.sort_hix','t.body_minx'),A('t.sort_hi','t.abody')],[
                      A('t.sort_lox','t.body_minx'),A('t.sort_lo','t.abody'),A('t.sort_hix','t.cell_minx'),A('t.sort_hi','t.cell_id'),swapShapes(),
                    ]),
                  ]),
                ]),
                If('t.do_contact',collide()),A('t.shape','t.shape+1'),
              ]),
            ]),A('t.pair','t.pair+1'),A('t.cell_id','t.cell_id+1'),A('t.cellz','t.cellz+1'),
          ]),A('t.celly','t.celly+1'),
        ]),A('t.cellx','t.cellx+1'),
      ]),A('t.contact_mode','t.contact_mode+1'),
    ]),
  ];
}

function separateBodyContacts() {
  if (!SHAPE_PAIRS.length) return [];
  const batches=[];
  for(const pair of SHAPE_PAIRS){
    let batch=batches.at(-1);
    if(!batch||batch.pairs.length>=128||new Set([...batch.indices,...pair]).size>24){batch={pairs:[],indices:[]};batches.push(batch);}
    batch.pairs.push(pair);for(const i of pair)if(!batch.indices.includes(i))batch.indices.push(i);
  }
  return batches.map(({pairs,indices})=>[If('v.simulation_collisions',[A("t.pair", 0), Loop(pairs.length, [
    A("t.shape_a",choose("t.pair",pairs.map(p=>indices.indexOf(p[0])))),A("t.shape_b",choose("t.pair",pairs.map(p=>indices.indexOf(p[1])))),
    loadShape("t.a","t.shape_a",indices),loadShape("t.b","t.shape_b",indices),
    A("t.bound_a",choose("t.abody",BODIES.map((_,i)=>`v.d${i}minx`))),A("t.bound_b",choose("t.bbody",BODIES.map((_,i)=>`v.d${i}minx`))),
    If("t.bound_a<t.bound_b || (t.bound_a==t.bound_b && t.abody<t.bbody)",[
      A("t.sort_lox","t.bound_a"),A("t.sort_lo","t.abody"),A("t.sort_hix","t.bound_b"),A("t.sort_hi","t.bbody"),
      swapShapes(),
    ],[A("t.sort_lox","t.bound_b"),A("t.sort_lo","t.bbody"),A("t.sort_hix","t.bound_a"),A("t.sort_hi","t.abody")]),
    collide(), A("t.pair", "t.pair+1"),
  ])])]);
}
function separateTerrainContacts() {
  const at = "t.cellx-math.floor(v.ex),t.celly-math.floor(v.ey),t.cellz-math.floor(v.ez)";
  const tags = values => values.map(value => `'${value}'`).join(",");
  const solid = `q.relative_block_has_any_tag(${at},${tags(settings.terrain.includeTags)})${settings.terrain.excludeTags.length ? `&&!q.relative_block_has_any_tag(${at},${tags(settings.terrain.excludeTags)})` : ""}`;
  return [vector("t.min",[1e6,1e6,1e6]),vector("t.max",[-1e6,-1e6,-1e6]),
    SHAPES.map((_,i)=>[axes.flatMap(k=>[A("t.min"+k,`math.min(t.min${k},v.s${i}${k}-v.s${i}e${k})`),A("t.max"+k,`math.max(t.max${k},v.s${i}${k}+v.s${i}e${k})`)])]),
    axes.flatMap(k=>[A("t.min"+k,`math.floor(v.o${k}+t.min${k}/16)`),A("t.max"+k,`math.floor(v.o${k}+t.max${k}/16)`)]),
    A("v.terrain_minx","t.minx"),A("v.terrain_yz","(t.maxy-t.miny+1)*(t.maxz-t.minz+1)"),
    A('t.terrain_external','v.ragdoll_terrain_mode>0'),Loop('v.ragdoll_terrain_mode==2?2:1',[
    A("t.cell_id",`t.terrain_external?${GROUND}:${NATIVE_GROUND}`),A("t.cellx","t.minx"),Loop(`t.terrain_external?math.clamp(v.ragdoll_terrain_count,0,${MAX_TERRAIN_BOXES}):t.maxx-t.minx+1`,[A("t.celly","t.miny"),Loop("t.terrain_external?1:t.maxy-t.miny+1",[A("t.cellz","t.minz"),Loop("t.terrain_external?1:t.maxz-t.minz+1",[
      terrainCell(solid),If('t.solid',[A("t.shape",0),Loop(SHAPES.length,[
        loadShape("t.a","t.shape"),terrainShape(),
        basis("t.au","t.aq"),
        If(axes.map(k=>`math.abs(t.a${k}-t.b${k})<=t.bh${k}+(${axes.map((l,j)=>`math.abs(t.au${j}${k})*t.ah${l}`).join('+')})`).join("&&"),[
          vector("t.bq",[0,0,0]),A("t.bqw",1),A("t.bbody",GROUND),
          A("t.body_minx",choose("t.abody",BODIES.map((_,i)=>`v.d${i}minx`))),
          A("t.cell_minx","t.bx-t.bhx"),
          If("t.cell_minx<t.body_minx",[A("t.sort_lox","t.cell_minx"),A("t.sort_lo","t.cell_id"),A("t.sort_hix","t.body_minx"),A("t.sort_hi","t.abody")],[
            A("t.sort_lox","t.body_minx"),A("t.sort_lo","t.abody"),A("t.sort_hix","t.cell_minx"),A("t.sort_hi","t.cell_id"),
            swapShapes(),
          ]),collide(),
        ]),A("t.shape","t.shape+1"),
      ])]),A("t.cell_id","t.cell_id+1"),A("t.cellz","t.cellz+1"),
    ]),A("t.celly","t.celly+1")]),A("t.cellx","t.cellx+1")]),
    A('t.terrain_external',0)]),
  ];
}


const separateContacts = SHAPES.length>24 || CONTACT_LIMIT>128;
function bodyContacts(){return separateContacts?separateBodyContacts():contacts();}
function terrainContacts(){return separateContacts?separateTerrainContacts():[];}
function sortContacts() {
  const keys=["lox","lo","hix","hi"];
  const loadKey=(out,index)=>[...["lo","hi"].map(k=>A(out+k,choose(index,slots.map(i=>`v.c${i}${k}`)))),
    ...["lo","hi"].map(k=>A(out+k+"x",`${out+k}<${GROUND}?(${choose(out+k,BODIES.map((_,i)=>`v.d${i}minx`))}):(${out+k}<${NATIVE_GROUND}?((${terrainValue(`${out+k}-${GROUND}`, 'minx')})-v.ox)*16:((v.terrain_minx+math.floor((${out+k}-${NATIVE_GROUND})/v.terrain_yz)+0.5-v.ox)*16-8))`))];
  const less=keys.reduceRight((rest,k)=>`(t.key_${k}<t.other_${k}||(t.key_${k}==t.other_${k}&&${rest}))`,"0");
  return [A("t.i",0),Loop("v.contact_count",[
    loadKey("t.key_","t.i"),A("t.insert","t.i"),A("t.moving",1),
    Loop("t.i",[If("t.moving&&t.insert>0",[
      A("t.previous",choose("t.insert-1",slots.map(i=>`v.order${i}`))),loadKey("t.other_","t.previous"),
      If(less,[dispatch("t.insert",slots,i=>A(`v.order${i}`,"t.previous")),A("t.insert","t.insert-1")],A("t.moving",0)),
    ])]),dispatch("t.insert",slots,i=>A(`v.order${i}`,"t.i")),A("t.i","t.i+1"),
  ]),pagedContacts?Array.from({length:3},(_,group)=>{
    const fields=[...contactKeys,'l0','l1','l2'].slice(group*5,group*5+5);
    return [A('t.copy_contact',0),Loop('v.contact_count',[
      A('t.copy_slot',choose('t.copy_contact',slots.map(i=>`v.order${i}`))),
      dispatch('t.copy_slot',slots,i=>fields.filter(k=>!/^l[012]$/.test(k)).map(k=>A('t.copy_'+k,`v.c${i}.${k}`))),
      dispatch('t.copy_contact',slots,i=>fields.map(k=>A(solvedContact(i,k),/^l[012]$/.test(k)?0:'t.copy_'+k))),
      A('t.copy_contact','t.copy_contact+1'),
    ])];
  }):[]];
}

function equation(lambda, angular = false, hinge = false) {
  return [matrix("t.response_a", "t.da", "t.ga"), matrix("t.response_b", "t.db", "t.gb"),
    A("t.denominator", `${hinge?'':'t.daim+t.dbim+'}(${dot("t.ga", "t.response_a")})+(${dot("t.gb", "t.response_b")})+t.eps`),
    A("t.gw", `${angular ? "0" : `(${dot("t.n", "t.dbv")})-(${dot("t.n", "t.dav")})`}+(${dot("t.ga", "t.daw")})+(${dot("t.gb", "t.dbw")})`),
    A("t.gdelta", `${angular ? "0" : `(${dot("t.n", "t.dbdv")})-(${dot("t.n", "t.dadv")})`}+(${dot("t.ga", "t.dadw")})+(${dot("t.gb", "t.dbdw")})`),
    A("t.rhs", `-t.g*t.stiff-t.gw*t.relax${angular ? "" : "+t.bounce*math.max(0,-t.gw)"}${angular ? "" : `+(v.ragdoll_simulation_gravity_vector?-(${dot('v.gravity_step_','t.n')}):${gravityValue(dt)}*t.ny)*((t.dbim>0)-(t.daim>0))`}`),
    A("t.next", `math.clamp(${lambda}+(t.rhs-t.gdelta-t.eps*${lambda})/t.denominator,t.lower,t.upper)`), A("t.impulse", `t.next-${lambda}`), A(lambda, "t.next"),
    ...(!angular ? axes.flatMap(k => [A("t.dadv" + k, `t.dadv${k}-t.n${k}*t.daim*t.impulse`), A("t.dbdv" + k, `t.dbdv${k}+t.n${k}*t.dbim*t.impulse`)]) : []),
    axes.flatMap(k => [A("t.dadw" + k, `t.dadw${k}+t.response_a${k}*t.impulse`), A("t.dbdw" + k, `t.dbdw${k}+t.response_b${k}*t.impulse`)]),
  ];
}
const material = key => {
  const ground=`t.ground_${key}`;
  const a = choose("t.cia", [...BODIES.map((_,i) => materialValue(rig,i,key)), ground]), b = choose("t.cib", [...BODIES.map((_,i) => materialValue(rig,i,key)), ground]);
  return key === "restitution" ? `math.max(${a},${b})` : `math.sqrt((${a})*(${b}))`;
};
function contactSolve() {
  const prefix='t.c',friction='t.phase==0';
  const pages=pagedContacts?Array.from({length:Math.ceil(slots.length/64)},(_,i)=>slots.slice(i*64,i*64+64)):[slots];
  return [A('t.phase',rig.contactFriction===false?1:0),Loop(rig.contactFriction===false?1:2,[
    If('t.phase==1||v.simulation_friction',pages.map(page=>[A('t.contact_id',page[0]),Loop(pagedContacts?`math.clamp(v.contact_count-${page[0]},0,${page.length})`:'v.contact_count',[
      A('t.slot',pagedContacts?'t.contact_id':choose('t.contact_id',slots.map(i=>'v.order'+i))),
      dispatch('t.slot',page,i=>[...contactKeys,'l0','l1','l2'].map(k=>A((k==='g'||k.startsWith('ra')||k.startsWith('rb')?'t.':prefix)+k,solvedContact(i,k))),page[0]),
      A('t.cia','math.min(t.chi,'+GROUND+')'),A('t.cib','math.min(t.clo,'+GROUND+')'),
      A('t.ground_friction',settings.terrain.friction),A('t.ground_restitution',settings.terrain.restitution),
      If(`math.max(t.clo,t.chi)>=${GROUND}&&math.max(t.clo,t.chi)<${NATIVE_GROUND}`,[
        A('t.material_index',`math.max(t.clo,t.chi)-${GROUND}`),
        ...['friction','restitution'].map(key=>A('t.ground_'+key,terrainValue('t.material_index',key))),
      ]),
      loadBody('t.da',prefix+'ia'),loadBody('t.db',prefix+'ib'),
      A('t.relax',12/13),A('t.eps',4/(dt*dt*1e7*13)),A('t.stiff',friction+'?0:'+4/(dt*13)),
      If(friction,[
        // The reference axis is either X or Y. Preserve signed zero while
        // removing the normal copy and construction of three unit components.
        A('t.bounce',0),If('math.abs(t.cnx)<0.9',[
          A('t.tangent0x','t.cny*0-t.cnz*0'),A('t.tangent0y','t.cnz-t.cnx*0'),A('t.tangent0z','t.cnx*0-t.cny'),
        ],[
          A('t.tangent0x','t.cny*0-t.cnz'),A('t.tangent0y','t.cnz*0-t.cnx*0'),A('t.tangent0z','t.cnx-t.cny*0'),
        ]),cross('t.tangent1',prefix+'n','t.tangent0'),
        A('t.upper','('+material('friction')+')*'+gravityValue()+'/(t.daim+t.dbim)'),A('t.lower','-t.upper'),
      ],[A('t.lower',0),A('t.upper',1e6)]),
      A('t.tangent_id',friction+'?0:2'),Loop(friction+'?2:1',[
        axes.map(k=>A('t.n'+k,choose('t.tangent_id',['t.tangent0'+k,'t.tangent1'+k,prefix+'n'+k]))),
        cross('t.ga','t.ra','t.n'),scale('t.ga','t.ga',-1),cross('t.gb','t.rb','t.n'),If('t.phase==1',A('t.bounce',material('restitution'))),
        A('t.lambda',choose('t.tangent_id',[prefix+'l0',prefix+'l1',prefix+'l2'])),equation('t.lambda'),
        dispatch('t.tangent_id',[0,1,2],i=>A(prefix+'l'+i,'t.lambda')),A('t.tangent_id','t.tangent_id+1'),
      ]),
      saveDelta('t.da',prefix+'ia'),saveDelta('t.db',prefix+'ib'),
      dispatch('t.slot',page,i=>[0,1,2].map(k=>A(solvedContact(i,'l'+k),prefix+'l'+k)),page[0]),
      A('t.contact_id','t.contact_id+1'),
    ])])),A('t.phase','t.phase+1'),
  ])];
}
function hingeSolve(ids,pick){
  return [
    ...['a','b'].flatMap(side=>[
      ...axes.map((k,n)=>pick('t.h_local'+k,ids.map(i=>JOINTS[i]['axis'+side.toUpperCase()][n]))),
      ...quat.map(k=>A('t.h_bodyq'+k,choose('t.j'+side,BODIES.map((_,i)=>'v.b'+i+'q'+k)))),
      rotate('t.h_axis_'+side,'t.h_bodyq','t.h_local'),
      ...axes.map((k,n)=>pick('t.h_local'+k,ids.map(i=>JOINTS[i]['twistAxis'+side.toUpperCase()][n]))),
      rotate('t.h_ref_'+side,'t.h_bodyq','t.h_local'),
    ]),hingeFrame(),cross('t.h_tangent','t.h_axis_a','t.h_ref_a'),
    A('t.h_transition',`math.max(0,1-v.age/${settings.poseTransition})`),
    scale('t.h_error','t.h_error','math.max(0,t.h_swing-v.scratch_joint.swing*t.h_transition)/math.max(t.h_swing,0.000001)'),
    A('t.relax',1),A('t.eps',4/(dt*dt*1e7*17)),A('t.stiff',.6/dt),A('t.lower',-1e6),A('t.upper',1e6),
    // Two bilateral rows remove angular velocity perpendicular to the hinge.
    // Their axes remain nonzero even when both ends are perfectly aligned.
    A('t.h_row',0),Loop(2,[
      axes.map(k=>A('t.gb'+k,'t.h_row?t.h_tangent'+k+':t.h_ref_a'+k)),scale('t.ga','t.gb',-1),
      A('t.g',dot('t.h_error','t.gb')),A('t.lambda','t.h_row?v.scratch_joint.l4:v.scratch_joint.l3'),equation('t.lambda',true,true),
      If('t.h_row',A('v.scratch_joint.l4','t.lambda'),A('v.scratch_joint.l3','t.lambda')),A('t.h_row','t.h_row+1'),
    ]),
    pick('t.h_min',ids.map(i=>JOINTS[i].minAngle)),pick('t.h_max',ids.map(i=>JOINTS[i].maxAngle)),
    A('v.scratch_joint.hinge_angle',nearestAngle('t.h_angle','v.scratch_joint.hinge_angle')),
    // A full turn is an unlimited hinge; otherwise use separate unilateral stops.
    If('t.h_max-t.h_min<360',[
      A('t.h_min','t.h_min+math.min(0,v.scratch_joint.hinge_initial-t.h_min)*t.h_transition'),
      A('t.h_max','t.h_max+math.max(0,v.scratch_joint.hinge_initial-t.h_max)*t.h_transition'),
      copy('t.gb','t.h_axis_a'),scale('t.ga','t.gb',-1),A('t.h_row',0),Loop(2,[
        A('t.g','(v.scratch_joint.hinge_angle-(t.h_row?t.h_max:t.h_min))*0.017453292519943295'),
        A('t.lower','t.h_row?-1000000:0'),A('t.upper','t.h_row?0:1000000'),
        A('t.stiff',`(t.h_row?t.g>0:t.g<0)?${.3/dt}:${1/dt}`),
        A('t.lambda','t.h_row?v.scratch_joint.l6:v.scratch_joint.l5'),equation('t.lambda',true,true),
        If('t.h_row',A('v.scratch_joint.l6','t.lambda'),A('v.scratch_joint.l5','t.lambda')),A('t.h_row','t.h_row+1'),
      ]),
    ]),
  ];
}
function jointGeometry(nodes,fields,prefix,selector='t.joint_id',count=JOINTS.length){
  if(ITERATIONS===1)return nodes;
  const slots=Array.from({length:count},(_,i)=>i);
  const name=(i,field)=>`v.joint_cache_${prefix}_${i}_${field.slice(2)}`;
  // Body poses only change after all iterations. Refill on iteration zero of
  // each physical step; velocities, accumulated impulses and hinge tracking
  // remain in the solver. Separate scalars avoid widening joint state records.
  return If('v.input_iteration==0',[
    nodes,dispatch(selector,slots,i=>fields.map(field=>A(name(i,field),field))),
  ],dispatch(selector,slots,i=>fields.map(field=>A(field,name(i,field)))));
}
function jointSolve() {
  if (!JOINTS.length) return [];
  const ids=rig.jointOrder;
  const pick=(out,values)=>A(out,choose('t.joint_id',values));
  const angular=cone=>!hasHinges?cone:JOINTS.every(j=>j.hinge===1)?hingeSolve(ids,pick):If(choose('t.joint_id',ids.map(i=>JOINTS[i].hinge)),hingeSolve(ids,pick),cone);
  return [A('t.joint_id',0),Loop(ids.length,[
    If(choose('t.joint_id',ids.map(i=>`v.joint_enabled_${i}`)),[
    pick('t.ja',ids.map(i=>JOINTS[i].a)),pick('t.jb',ids.map(i=>JOINTS[i].b)),
    A('v.scratch_joint',choose('t.joint_id',ids.map(i=>'v.j'+i))),
    A('t.bounce',0),loadBody('t.da','t.ja'),loadBody('t.db','t.jb'),
    jointGeometry(['a','b'].flatMap(side=>[
      ...axes.map(k=>A('t.local'+k,'v.scratch_joint.'+side+k+'*16')),
      ...quat.map(k=>A('t.jq'+k,choose('t.j'+side,BODIES.map((_,i)=>'v.b'+i+'q'+k)))),
      rotate('t.r'+side,'t.jq','t.local'),
    ]),['a','b'].flatMap(side=>axes.map(k=>'t.r'+side+k)),'anchor'),
    A('t.relax',16/17),A('t.eps',4/(1/60*1/60*1e7*17)),A('t.stiff',240/17),A('t.lower',-1e6),A('t.upper',1e6),
    A('t.row',0),Loop(3,[
      vector('t.n',axes.map((l,i)=>'t.row=='+i)),cross('t.ga','t.ra','t.n'),scale('t.ga','t.ga',-1),cross('t.gb','t.rb','t.n'),
      A('t.g',choose('t.row',axes.map(k=>choose('t.jb',BODIES.map((_,i)=>'v.d'+i+'.'+k))+'+t.rb'+k+'-('+choose('t.ja',BODIES.map((_,i)=>'v.d'+i+'.'+k))+')-t.ra'+k))),
      A('t.lambda',choose('t.row',[0,1,2].map(i=>'v.scratch_joint.l'+i))),equation('t.lambda'),dispatch('t.row',[0,1,2],i=>A('v.scratch_joint.l'+i,'t.lambda')),
      A('t.row','t.row+1'),
    ]),A('t.upper',0),
    angular([A('t.twist',0),Loop(2,[
      ...(ITERATIONS>1?[A('t.constraint','t.joint_id*2+t.twist')]:[]),jointGeometry([
      ...['a','b'].flatMap(side=>[
        ...axes.map((k,n)=>pick('t.local'+k,ids.map(i=>'t.twist?('+JOINTS[i]['twistAxis'+side.toUpperCase()][n]+'):('+JOINTS[i]['axis'+side.toUpperCase()][n]+')'))),
        ...quat.map(k=>A('t.jq'+k,choose('t.j'+side,BODIES.map((_,i)=>'v.b'+i+'q'+k)))),
        rotate('t.axis_'+side,'t.jq','t.local'),
      ]),
      cross('t.ga','t.axis_b','t.axis_a'),cross('t.gb','t.axis_a','t.axis_b'),
      pick('t.limit',ids.map(i=>'t.twist?('+JOINTS[i].twist+'):('+JOINTS[i].swing+')')),
      A('t.initial_limit','t.twist?v.scratch_joint.twist:v.scratch_joint.swing'),
      A('t.g','math.cos(t.limit+math.max(0,t.initial_limit-t.limit)*math.max(0,1-v.age/'+settings.poseTransition+'))-('+dot('t.axis_a','t.axis_b')+')'),
      ],[...['ga','gb'].flatMap(side=>axes.map(k=>'t.'+side+k)),'t.g'],'angle','t.constraint',JOINTS.length*2),
      A('t.lambda','t.twist?v.scratch_joint.l4:v.scratch_joint.l3'),equation('t.lambda',true),If('t.twist',A('v.scratch_joint.l4','t.lambda'),A('v.scratch_joint.l3','t.lambda')),
      A('t.twist','t.twist+1'),
    ])]),saveDelta('t.da','t.ja'),saveDelta('t.db','t.jb'),dispatch('t.joint_id',ids,i=>A('v.j'+i,'v.scratch_joint'))]),A('t.joint_id','t.joint_id+1'),
  ])];
}
function solverChunks() {
  return [A('v.input_iteration',0),Loop(ITERATIONS,[If(`v.simulation_iterations<=0||v.input_iteration<math.clamp(v.simulation_iterations,1,${ITERATIONS})`,[contactSolve(),JOINTS.length?jointSolve():[]]),A('v.input_iteration','v.input_iteration+1')])];
}
function integrateBodies() {
  const b='v.scratch_b.',d='v.scratch_d.',decay=value=>typeof value==='number'?Math.pow(1-value,dt):'math.pow(1-('+value+'),'+dt+')';
  return [A('t.body_index',0),Loop(BODIES.length,[
    A('v.scratch_b',choose('t.body_index',BODIES.map((_,i)=>'v.b'+i))),A('v.scratch_d',choose('t.body_index',BODIES.map((_,i)=>'v.d'+i))),
    A('t.linear_decay',choose('t.body_index',BODIES.map((body,i)=>`v.ragdoll_property_count?${decay(materialValue(rig,i,'linearDamping'))}:${decay(body.linearDamping)}`))),A('t.angular_decay',choose('t.body_index',BODIES.map((body,i)=>`v.ragdoll_property_count?${decay(materialValue(rig,i,'angularDamping'))}:${decay(body.angularDamping)}`))),
    axes.map(k=>A(b+'v'+k,'(('+d+'v'+k+'+'+d+'dv'+k+')*t.linear_decay'+(k==='y'?`+(v.ragdoll_simulation_gravity_vector?v.gravity_step_y:-${gravityValue(dt)})`:`+v.gravity_step_${k}`)+')/16')),
    axes.map(k=>A(b+'w'+k,'('+d+'w'+k+'+'+d+'dw'+k+')*t.angular_decay')),
    axes.map(k=>A(b+k,b+k+'+'+b+'v'+k+'*'+dt)),
    vector('t.angular',axes.map(k=>b+'w'+k)),A('t.angularw',0),multiply('t.change','t.angular',b+'q'),
    quat.map(k=>A(b+'q'+k,b+'q'+k+'+t.change'+k+'*'+dt/2)),normalize(b+'q',quat),
    dispatch('t.body_index',BODIES,(_,i)=>A('v.b'+i,'v.scratch_b')),A('t.body_index','t.body_index+1'),
  ])];
}
return { initializeDynamics, prepareBodies, bodyContacts, terrainContacts, sortContacts, solverChunks, integrateBodies, jointSolve };
}
