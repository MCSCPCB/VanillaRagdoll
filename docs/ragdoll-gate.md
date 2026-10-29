# 布娃娃门控 / Ragdoll gate

VanillaRagdoll 的入口与恢复规则集中在 `src/animations/vanilla_ragdoll_gate.json`。发布包内对应的路径是 `animations/vanilla_ragdoll_gate.json`。

网页生成器会在每个补丁包中生成一份 `animations/sr_patch_web_<包标识>_gate.json`。每个原资源包的门控动画标识独立。修改一个补丁的门控不会改变其他补丁或 VanillaRagdoll 的规则。

编辑该动画的 `anim_time_update` 即可，不需要修改实体定义或重新生成物理求解代码。保存后重新加载资源包。默认表达式如下：

```molang
v.vr_trigger = v.vr_native_trigger || q.is_name_any('ragdoll');
v.vr_release = v.vr_native_release && !q.is_name_any('ragdoll');
return 0;
```

| 变量 | 含义 |
|---|---|
| `v.vr_native_trigger` | 当前生物的原有死亡或已支持的濒死判定。网页补丁使用普通死亡判定 |
| `v.vr_native_release` | 当前生物的原有恢复判定，包括存活、复活或取消已支持的濒死阶段 |
| `v.vr_trigger` | 允许进入布娃娃，为 0 时不会新触发 |
| `v.vr_release` | 允许退出已有布娃娃，为 1 时恢复原有动画 |

每次执行都给两个输出变量赋值。进入和恢复条件应互斥。只关闭进入条件不会自动停止已有的布娃娃，还需要相应的恢复条件。门控在每个生物自己的上下文里求值，变量不在生物之间共享。玩家第一人称、纸娃娃和 UI 等排除条件仍由实体端保证。

例如，只保留死亡及原有濒死触发，取消命名牌入口：

```molang
v.vr_trigger = v.vr_native_trigger;
v.vr_release = v.vr_native_release;
return 0;
```

全部关闭，并恢复已有布娃娃：

```molang
v.vr_trigger = 0;
v.vr_release = 1;
return 0;
```

只通过命名牌控制：

```molang
v.vr_trigger = q.is_name_any('ragdoll');
v.vr_release = !q.is_name_any('ragdoll');
return 0;
```

这些代码需要作为 JSON 的字符串值保存，不能直接把多行代码粘贴到引号之间。以下是可以直接使用的完整 VanillaRagdoll 门控文件，规则为“仅死亡及原有濒死触发”：

```json
{
  "format_version": "1.20.60",
  "animations": {
    "animation.vanilla_ragdoll.gate": {
      "loop": true,
      "animation_length": 1,
      "anim_time_update": "v.vr_trigger=v.vr_native_trigger;v.vr_release=v.vr_native_release;return 0;"
    }
  }
}
```

编辑网页补丁时保留该补丁原有的动画标识。重新从原包生成补丁会重新使用默认规则。

# English

Edit `anim_time_update` in `animations/vanilla_ragdoll_gate.json` to change entry and recovery rules for the entire VanillaRagdoll pack. Each website-generated patch has its own `animations/sr_patch_web_<pack-id>_gate.json`, with an independent animation identifier. Editing one patch does not change other patches or VanillaRagdoll.

The default policy combines the entity's existing death or supported pre-death condition with the `ragdoll` name-tag trigger. `v.vr_native_trigger` and `v.vr_native_release` supply those existing conditions. Website patches use ordinary death and recovery. Set `v.vr_trigger` and `v.vr_release` on every evaluation, and keep their conditions mutually exclusive. Setting only the trigger to zero prevents new ragdolls but does not release active ones.

The examples above show the default policy, death-only entry, disabling all ragdolls, and name-only entry. Store the expression as a valid JSON string and keep the existing animation identifier. Reload the resource pack after saving. No physics recompilation or entity-file edits are needed. The gate evaluates separately for each entity, and first-person, paperdoll and UI exclusions remain enforced. Regenerating a website patch restores its default policy.
