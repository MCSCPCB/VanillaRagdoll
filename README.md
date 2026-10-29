# 香草布娃娃

香草布娃娃基于 [Simple Ragdoll](https://github.com/MCSCPCB/Simple-Ragdoll) 开发，为原版生物和玩家添加物理驱动的布娃娃效果。

该项目完全基于资源包实现，无需任何行为包。同时它还配备了一个简单的[布娃娃生成器](https://mcscpcb.github.io/VanillaRagdoll/)，方便创作者为附加包 Add-on 制作独立的布娃娃补丁。

## 特性

- 原版生物与玩家的死亡物理布娃娃
- 纯资源包，无需依赖行为包
- 修改 `animations/_gate.json` 动画文件中的 Molang 变量，自定义布娃娃触发条件
- 使用命名牌将生物命名为 `ragdoll` ，也可以触发布娃娃
- 通过布娃娃生成器，为指定的附加包 Add-on 制作简化的布娃娃效果

# Vanilla Ragdoll

Vanilla Ragdoll adds physics-driven ragdolls for vanilla mobs and players using [Simple Ragdoll](https://github.com/MCSCPCB/Simple-Ragdoll).

It runs entirely as a resource pack, with no behavior pack required. A simple [Ragdoll Generator](https://mcscpcb.github.io/VanillaRagdoll/) also lets creators make separate ragdoll patches for their add-ons.

## Features

- Death ragdolls for vanilla mobs and players
- Resource pack only, with no behavior pack required
- Customize ragdoll triggers by editing the Molang variables in animation files ending in `_gate.json` under `animations/`
- Name a mob `ragdoll` with a name tag to activate ragdoll physics
- Use the Ragdoll Generator to create simplified ragdoll effects for your add-ons
