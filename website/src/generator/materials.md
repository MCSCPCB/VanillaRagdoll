# Material and liquid presets

`materials.mjs` and `water-buoyancy.mjs` are shared by the local VanillaRagdoll
builder and both website compiler paths. These settings affect active ragdolls.
They do not change an entity's vanilla behavior, model, live animations, or damage.

The density numbers below are **relative gameplay parameters**, with water = 1.
They are not measured Minecraft material properties or real-world mass in kg.
Ordinary bodies retain the previous water buoyancy of 1.2 times their weight.

| Bodies | Material | Relative density | Friction |
|---|---|---:|---:|
| Ordinary mobs, unknown custom models | Organic | 0.8333… | Keep authored value |
| Iron golem | Iron | 7.85 | 0.35 |
| Copper golem | Copper | 8.96 | 0.40 |
| Snow golem body and snow head | Snow | 0.45 | 0.15 |
| Snow golem arms, creaking | Wood | 0.65 | 0.50 |
| Skeleton, stray, bogged, parched, wither skeleton, skeleton horse, wither | Bone | 1.70 | 0.35 |
| Slime | Gel | 1.05 | 0.80 |
| Magma cube | Magma | 1.80 | 0.60 |
| Sulfur cube | Sulfur-like | 1.50 | 0.60 |
| Blaze | Fire creature | 1.60 | 0.40 |
| Breeze | Wind creature | 0.45 | 0.20 |

Snow golem's pumpkin is a native render attachment, not a separate physical body.
Guardians, shulkers and wardens retain ordinary material. Unknown custom models
also retain ordinary material; names and textures do not establish composition.
Verified vanilla geometry profiles in uploaded packs inherit their vanilla family.
Slime, magma cube and sulfur cube keep their authored restitution of 1.

## Mass and displacement

The original configurations use several historical mass conventions and collision
envelopes simplified for performance. Treating those envelopes as solid displaced
volume would make collider edits change sinking behavior unintentionally.

For each body, the authored mass is the reference mass `m0` and the original
organic density is `rho0 = 1 / 1.2`. We define an effective displacement `V = m0 /
rho0`, then use `mass = V * materialDensity`. Inverse mass and inverse inertia
change together, preserving the authored shape and relative mass distribution
within each material. Existing fixed-mass/density-derived scale conventions are
retained; the effective displacement follows that same convention. This is a
calibrated volume, not the geometric union of model cubes.

Constraint compliance is divided by the rig's mass multiplier, and fixed impulse
ceilings are multiplied by it. Without this adjustment, increasing metal mass
would soften joints or hit the solver's old impulse ceiling. No extra solver
iterations are introduced. Mixed snow/wood rigs use their total mass ratio for
this solver normalization.

## Liquid sampling

| Fluid | Relative density | Linear drag | Angular drag |
|---|---:|---:|---:|
| Water | 1 | 2 | 3 |
| Lava | 2.6 | 8 | 12 |

Each body's representative collider has two interior sample points. Each point
contributes half of the effective displacement. Its liquid density determines
buoyancy and its offset supplies torque. Water and lava at different points are
accumulated independently. Drag is exponential and accounts for body density.
Iron and copper sink in both liquids. Bone, gel and the denser fantasy materials
sink in water and float in lava. Snow and wood float in both.

Dry bodies make two liquid-tag queries per physics step. Wet points each require
one additional lava query, for at most four queries per body per step. Sleeping
dry bodies keep the existing polling interval; immersion wakes them. Alive/UI
contexts do not run liquid physics. Wet bodies remain awake to respond to buoyancy.

Whole-cell tags and two points approximate immersion. This does not reconstruct
flowing liquid levels, simulate currents, burning or melting, or guarantee a still
waterline. Small oscillations at the surface remain possible. Offline generated-code
tests measure forces, trajectories and work counts; game FPS and appearance still
require Bedrock testing.
