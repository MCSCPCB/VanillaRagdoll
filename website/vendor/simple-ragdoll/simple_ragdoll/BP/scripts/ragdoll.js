export const INPUT_ANIMATION = "animation.simple_ragdoll.input";
export const MAX_TERRAIN_BOXES = 64;
export const MAX_MOTIONS = 32;
export const MAX_FORCES = 16;
export const MAX_PROPERTIES = 33;
export const MAX_JOINTS = 64;
export const MAX_LIQUIDS = 16;
export const PROPERTY_FIELDS = ["mass", "friction", "restitution", "linearDamping", "angularDamping"];
export const MOTION_FIELDS = ["seq", "kind", "part", "linear", "x", "y", "z", "angular", "ax", "ay", "az", "point", "px", "py", "pz", "rotation", "qx", "qy", "qz", "qw"];
export const FORCE_FIELDS = ["part", "x", "y", "z", "point", "px", "py", "pz", "ax", "ay", "az"];
export const BP_API_METHODS = ["applyImpulse", "setVelocity", "setForce", "setTransform", "setProperties", "setJointsEnabled", "setTerrain", "setEnvironment"];

const controllers = new Map();
let lastSession = 0;
const axes = ["x", "y", "z"];
const motionFields = MOTION_FIELDS;
const forceFields = FORCE_FIELDS;
const modes = { auto: 0, active: 1, inactive: 2, paused: 3 };
const finite = (value, name, min = -1e6, max = 1e6) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new RangeError(name);
  return value;
};
const vec = (value, name) => Object.fromEntries(axes.map(k => [k, finite(value?.[k], `${name}.${k}`)]));
const known = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("options");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(key);
};
const bool = (value, name) => {
  if (typeof value !== "boolean") throw new TypeError(name);
  return Number(value);
};
const number = value => String(Object.is(value, -0) ? 0 : value);

export function partKey(name) {
  if (name === undefined) return 0;
  if (typeof name !== "string" || !name.length) throw new TypeError("part");
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return (hash >>> 0) % 16777215 + 1;
}

function motion(kind, value, options) {
  known(options, kind === 1 ? ["part", "angularVelocity"] : ["part", "point", "angularImpulse", "torque"]);
  if (kind === 2 && options.torque !== undefined || kind === 4 && options.angularImpulse !== undefined) throw new TypeError("angular action");
  const result = { kind, part: partKey(options.part), linear: Number(value !== undefined), x: 0, y: 0, z: 0, angular: 0, ax: 0, ay: 0, az: 0, point: 0, px: 0, py: 0, pz: 0, rotation: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  if (value !== undefined) Object.assign(result, vec(value, "vector"));
  const spin = kind === 1 ? options.angularVelocity : kind === 4 ? options.torque : options.angularImpulse;
  if (spin !== undefined) {
    const angular = vec(spin, "angular");
    result.angular = 1;
    for (const k of axes) result["a" + k] = angular[k];
  }
  if (options.point !== undefined) {
    const point = vec(options.point, "point");
    result.point = 1;
    for (const k of axes) result["p" + k] = point[k];
  }
  if (value === undefined && spin === undefined) throw new TypeError("Empty motion");
  return result;
}

function terrain(box, origin = { x: 0, y: 0, z: 0 }) {
  known(box, ["min", "max", "type", "friction", "restitution", "density", "drag", "angularDrag"]);
  const min = vec(box.min, "min"), max = vec(box.max, "max");
  for (const k of axes) { min[k] = finite(min[k] + origin[k], "min"); max[k] = finite(max[k] + origin[k], "max"); }
  if (axes.some(k => min[k] >= max[k])) throw new RangeError("terrain bounds");
  const liquid = box.type === "liquid";
  if (box.type !== undefined && !["solid", "liquid"].includes(box.type)) throw new TypeError("region type");
  return liquid ? { min, max, density: finite(box.density ?? 1000, "density", 0, 1e6), drag: finite(box.drag ?? 2, "drag", 0, 100), angularDrag: finite(box.angularDrag ?? 2, "angularDrag", 0, 100) }
    : { min, max, friction: box.friction == null ? -1 : finite(box.friction, "friction", 0, 10), restitution: box.restitution == null ? -1 : finite(box.restitution, "restitution", 0, 1) };
}

function terrainBounds(bounds, boxes, origin) {
  if (bounds === undefined) return null;
  known(bounds, ["min", "max"]);
  const { min, max } = terrain(bounds, origin);
  if (axes.some(k => !Number.isInteger(min[k]) || !Number.isInteger(max[k]))) throw new RangeError("Integer terrain bounds required");
  if (boxes === null || boxes.some(box => axes.some(k => box.min[k] < min[k] || box.max[k] > max[k]))) throw new RangeError("Terrain outside bounds");
  return { min, max };
}

export class Ragdoll {
  constructor(entity) {
    if (!entity?.isValid || typeof entity.playAnimation !== "function") throw new Error("Invalid entity");
    const current = controllers.get(entity.id);
    if (current) return current;
    this._entity = entity;
    this._id = entity.id;
    this._session = lastSession = Math.max(Date.now(), lastSession + 1);
    this._revision = 0;
    this._sequence = 0;
    this._state = "auto";
    this._simulation = { gravity: -1, gravity_vector: 0, gx: 0, gy: 0, gz: 0, time_scale: 1, iterations: 0, collisions: 1, friction: 1, joints: 1 };
    this._terrain = null;
    this._terrainBounds = null;
    this._terrainSource = "setTerrain";
    this._jointsSource = null;
    this._liquids = [];
    this._properties = new Map();
    this._joints = new Map();
    this._batch = false;
    this._forces = new Map();
    this._motions = [];
    this._disposed = false;
    controllers.set(entity.id, this);
  }

  get entity() { return this._entity; }
  get isValid() { return !this._disposed && this.entity.isValid; }

  setState(state) {
    if (!Object.hasOwn(modes, state)) throw new TypeError("state");
    this._change(() => {
      this._state = state;
      if (state === "inactive") this._motions = [];
    });
  }

  setVelocity(velocity, options = {}) { this._motion(motion(1, velocity, options)); }
  applyImpulse(impulse, options = {}) { this._motion(motion(2, impulse, options)); }

  setTransform(transform, options = {}) {
    known(transform, ["position", "rotation"]); known(options, ["part"]);
    if (transform.position === undefined && transform.rotation === undefined) throw new TypeError("Empty transform");
    const entry = { ...motion(1, { x: 0, y: 0, z: 0 }, options), kind: 3, linear: Number(transform.position !== undefined) };
    if (entry.linear) Object.assign(entry, vec(transform.position, "position"));
    if (transform.rotation !== undefined) {
      known(transform.rotation, ["x", "y", "z", "w"]);
      const q = [...axes, "w"].map(k => finite(transform.rotation[k], "rotation." + k));
      const length = Math.hypot(...q); if (length < 1e-12) throw new RangeError("rotation");
      [...axes, "w"].forEach((k, i) => { entry["q" + k] = q[i] / length; }); entry.rotation = 1;
    }
    this._motion(entry);
  }

  setProperties(properties, options = {}) {
    known(properties, PROPERTY_FIELDS); known(options, ["part"]);
    const id = partKey(options.part), values = { ...(this._properties.get(id) ?? {}) };
    for (const [key, value] of Object.entries(properties)) {
      if (value === null) delete values[key];
      else values[key] = finite(value, key, key === "mass" ? 1e-6 : 0, key === "mass" ? 1e12 : key === "friction" ? 10 : key === "restitution" ? 1 : 0.999999);
    }
    this._change(() => {
      if (!Object.keys(values).length) this._properties.delete(id);
      else {
        if (!this._properties.has(id) && this._properties.size >= MAX_PROPERTIES) throw new RangeError("Too many property targets");
        this._properties.set(id, values);
      }
    });
  }

  setJointsEnabled(enabled, joint) {
    const value = bool(enabled, "enabled");
    if (joint === undefined) return this._change(() => { this._simulation = { ...this._simulation, joints: value }; this._jointsSource = "setJointsEnabled"; this._joints.clear(); });
    const id = partKey(joint);
    this._change(() => {
      if (!this._joints.has(id) && this._joints.size >= MAX_JOINTS) throw new RangeError("Too many joint targets");
      this._joints.set(id, value);
    });
  }

  batch(callback) {
    if (typeof callback !== "function" || callback.constructor?.name === "AsyncFunction" || this._batch) throw new TypeError("Synchronous non-nested batch required");
    this._change(() => {
      this._batch = true;
      try { if (callback(this)?.then) throw new TypeError("Synchronous batch required"); }
      finally { this._batch = false; }
    });
  }

  setForce(force, options = {}) {
    const entry = motion(4, force, options);
    this._change(() => {
      if (axes.every(k => entry[k] === 0 && entry["a" + k] === 0)) this._forces.delete(entry.part);
      else {
        if (!this._forces.has(entry.part) && this._forces.size >= MAX_FORCES) throw new RangeError("Too many force targets");
        this._forces.set(entry.part, entry);
      }
    });
  }

  setSimulationOptions(options) {
    known(options, ["gravity", "timeScale", "iterations", "selfCollisions", "friction", "joints"]);
    const next = { ...this._simulation };
    if (options.gravity !== undefined) {
      next.gravity_vector = Number(options.gravity !== null && typeof options.gravity === "object");
      if (next.gravity_vector) {
        const gravity = vec(options.gravity, "gravity"), length = Math.hypot(...axes.map(k => gravity[k]));
        finite(length, "gravity", 0, 100); next.gravity = length;
        for (const k of axes) next["g" + k] = gravity[k];
      } else next.gravity = options.gravity === null ? -1 : finite(options.gravity, "gravity", 0, 100);
    }
    if (options.timeScale !== undefined) next.time_scale = finite(options.timeScale, "timeScale", 0, 2);
    if (options.iterations !== undefined) {
      next.iterations = options.iterations === null ? 0 : finite(options.iterations, "iterations", 1, 12);
      if (!Number.isInteger(next.iterations)) throw new RangeError("iterations");
    }
    if (options.selfCollisions !== undefined) next.collisions = bool(options.selfCollisions, "selfCollisions");
    if (options.friction !== undefined) next.friction = bool(options.friction, "friction");
    if (options.joints !== undefined) next.joints = bool(options.joints, "joints");
    this._change(() => { this._simulation = next; if (options.joints !== undefined) { this._joints.clear(); this._jointsSource = null; } });
  }

  setTerrain(boxes, bounds) {
    if (boxes !== null && (!Array.isArray(boxes) || boxes.length > MAX_TERRAIN_BOXES)) throw new RangeError("terrain");
    const next = boxes?.map(box => { known(box, ["min", "max", "friction", "restitution"]); return terrain(box); }) ?? null;
    const coverage = terrainBounds(bounds, next);
    this._change(() => { this._terrain = next; this._terrainBounds = coverage; this._terrainSource = "setTerrain"; });
  }

  setEnvironment(environment) {
    if (environment === null) return this._change(() => { this._terrain = null; this._terrainBounds = null; this._liquids = []; this._terrainSource = "setEnvironment"; });
    known(environment, ["origin", "regions", "bounds"]);
    const origin = environment.origin === undefined ? { x: 0, y: 0, z: 0 } : vec(environment.origin, "origin");
    if (!Array.isArray(environment.regions)) throw new TypeError("regions");
    const solids = [], liquids = [];
    for (const region of environment.regions) (region.type === "liquid" ? liquids : solids).push(terrain(region, origin));
    if (solids.length > MAX_TERRAIN_BOXES || liquids.length > MAX_LIQUIDS) throw new RangeError("Too many regions");
    const coverage = terrainBounds(environment.bounds, solids, origin);
    this._change(() => { this._terrain = solids; this._terrainBounds = coverage; this._liquids = liquids; this._terrainSource = "setEnvironment"; });
  }

  dispose() {
    if (this._disposed) return;
    if (this._batch) throw new Error("Cannot dispose during batch");
    if (this.entity.isValid) this._change(() => {
      this._state = "auto";
      this._simulation = { gravity: -1, gravity_vector: 0, gx: 0, gy: 0, gz: 0, time_scale: 1, iterations: 0, collisions: 1, friction: 1, joints: 1 };
      this._terrain = null;
      this._terrainBounds = null;
      this._terrainSource = null;
      this._jointsSource = null;
      this._liquids = []; this._properties.clear(); this._joints.clear();
      this._forces.clear();
      this._motions = [];
    });
    this._disposed = true;
    controllers.delete(this._id);
  }

  _motion(entry) {
    this._change(() => {
      this._motions = this._motions.filter(item => Date.now() - item.time < 5000);
      if (this._motions.length >= MAX_MOTIONS) throw new RangeError("At most 32 motion commands in 5 seconds");
      if (this._sequence >= 16777214) throw new RangeError("Motion sequence exhausted");
      this._motions.push({ ...entry, seq: ++this._sequence, time: Date.now() });
    });
  }

  _change(update) {
    if (!this.isValid) throw new Error("Invalid ragdoll");
    const before = { state: this._state, simulation: this._simulation, terrain: this._terrain, terrainBounds: this._terrainBounds, terrainSource: this._terrainSource, jointsSource: this._jointsSource, liquids: this._liquids, properties: new Map(this._properties), joints: new Map(this._joints), forces: new Map(this._forces), motions: this._motions.slice(), sequence: this._sequence };
    try { update(); if (!this._batch) this._send(); }
    catch (error) {
      Object.assign(this, { _state: before.state, _simulation: before.simulation, _terrain: before.terrain, _terrainBounds: before.terrainBounds, _terrainSource: before.terrainSource, _jointsSource: before.jointsSource, _liquids: before.liquids, _properties: before.properties, _joints: before.joints, _forces: before.forces, _motions: before.motions, _sequence: before.sequence });
      throw error;
    }
  }

  _send() {
    if (this._revision >= 16777214) throw new RangeError("Input revision exhausted");
    const revision = this._revision + 1, writes = [];
    const put = (key, value) => writes.push(`v.ragdoll_${key}=${number(value)};`);
    // The server cannot read client variables. These guards run on the client;
    // older exports without a mask support all methods, as before.
    const guarded = (method, write) => {
      if (!method) { write(); return; }
      const bit = 2 ** BP_API_METHODS.indexOf(method);
      writes.push(`(math.mod(math.floor((v.ragdoll_api_mask??255)/${bit}),2))?{`);
      write(); writes.push('};');
    };
    put("control_mode", modes[this._state]);
    for (const [key, value] of Object.entries(this._simulation)) guarded(key === "joints" ? this._jointsSource : null, () => put("simulation_" + key, value));
    guarded(this._terrainSource, () => {
      put("terrain_mode", this._terrain === null ? 0 : this._terrainBounds ? 2 : 1);
      if (this._terrainBounds) for (const side of ["min", "max"]) for (const k of axes) put(`terrain_bounds_${side}${k}`, this._terrainBounds[side][k]);
      put("terrain_count", this._terrain?.length ?? 0);
      this._terrain?.forEach((box, i) => {
        for (const side of ["min", "max"]) for (const k of axes) put(`terrain_${i}_${side}${k}`, box[side][k]);
        for (const key of ["friction", "restitution"]) put(`terrain_${i}_${key}`, box[key]);
      });
    });
    guarded("setEnvironment", () => {
      put("liquid_count", this._liquids.length);
      this._liquids.forEach((box, i) => {
        for (const side of ["min", "max"]) for (const k of axes) put(`liquid_${i}_${side}${k}`, box[side][k]);
        for (const key of ["density", "drag", "angularDrag"]) put(`liquid_${i}_${key.toLowerCase()}`, box[key]);
      });
    });
    guarded("setProperties", () => {
      put("property_count", this._properties.size);
      [...this._properties].forEach(([id, values], i) => {
        put(`property_${i}_part`, id);
        for (const key of PROPERTY_FIELDS) put(`property_${i}_${key.toLowerCase()}`, values[key] ?? -1);
      });
    });
    guarded("setJointsEnabled", () => {
      put("joint_count", this._joints.size);
      [...this._joints].forEach(([id, value], i) => { put(`joint_${i}_id`, id); put(`joint_${i}_enabled`, value); });
    });
    guarded("setForce", () => {
      put("force_count", this._forces.size);
      [...this._forces.values()].forEach((force, i) => { for (const key of forceFields) put(`force_${i}_${key}`, force[key]); });
    });
    put("motion_first", this._motions[0]?.seq ?? this._sequence + 1);
    put("motion_last", this._sequence);
    this._motions.forEach(command => {
      const slot = (command.seq - 1) % MAX_MOTIONS;
      for (const key of motionFields) put(`motion_${slot}_${key}`, command[key]);
    });
    const high = Math.floor(this._session / 2097152), low = this._session % 2097152;
    const reset = `v.ragdoll_motion_ack=${(this._motions[0]?.seq ?? this._sequence + 1) - 1};v.ragdoll_session_high=${high};v.ragdoll_session_low=${low};v.ragdoll_revision=0;`;
    const newer = `v.ragdoll_session_high<${high}||(v.ragdoll_session_high==${high}&&v.ragdoll_session_low<${low})`;
    const current = `v.ragdoll_session_high==${high}&&v.ragdoll_session_low==${low}`;
    const expression = `((v.ragdoll_protocol??0)==1)?{(${newer})?{${reset}};(${current}&&v.ragdoll_revision<${revision})?{${writes.join("")}v.ragdoll_revision=${revision};};};return 0;`;
    if (expression.length > 64000) throw new RangeError("Input exceeds 64000 characters");
    this.entity.playAnimation(INPUT_ANIMATION, { controller: "simple_ragdoll_input", blendOutTime: 0, stopExpression: expression });
    this._revision = revision;
  }
}
