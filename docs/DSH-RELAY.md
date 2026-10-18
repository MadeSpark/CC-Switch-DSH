# DSH 中转与退出还原

DSH 中转把 DSH provider 的请求先送到 CC Switch 本机，再由 CC Switch 按原始地址转发。它的作用是为请求提供统一观察和统计入口，同时保留 DSH 自己管理 provider、凭据和当前模型的职责。准确的生命周期语义是：**CC Switch 运行期间中转，退出时按设置还原成直连**。

## 工作方式

开启 DSH 中转后，DSH provider 的 `baseURL` 会被改写为：

```text
http://127.0.0.1:<本地代理端口>/dsh/<providerId>
```

DSH 后续追加的 `/v1/messages`、`/v1/responses` 等路径会原样拼回原始地址。请求路径、查询参数、请求体和响应体按字节流透传；SSE 等流式响应也不重写 JSON。这样 DSH 收到的 `usage.inputTokens`、`usage.cacheReadTokens` 等字段保持原样。

每个 provider 需要同时保留两类地址：

- 原始直连地址：用户在 DSH provider 中配置的 API 地址。
- 中转地址：由本机监听端口和 `/dsh/<providerId>` 路径组成的地址。

设置页会显示中转是否已附加、本机中转地址，以及每个 provider 的“原始地址 → 中转地址”关系。前端状态接口模型位于 `src/lib/api/dsh.ts` 的 `DshRelayProvider` 和 `DshRelayStatus`。

## 命令、设置与状态文件

后端命令位于 `src-tauri/src/commands/dsh_relay.rs`：

- `dsh_relay_status()`：读取当前中转状态。
- `dsh_set_relay { enabled }`：开启或关闭 DSH 中转。
- `dsh_set_restore_on_exit { enabled }`：开启或关闭退出还原。

三个命令都返回 `DshRelayStatus`，字段使用 camelCase：`relayEnabled`、`restoreOnExit`、`attached`、`baseUrl`，以及包含 `providerId`、`name`、`originalBaseUrl`、`relayBaseUrl`、`relayed` 的 `providers` 数组。命令在 `src-tauri/src/lib.rs` 注册，前端绑定位于 `src/lib/api/dsh.ts`。

中转侧车状态文件为：

```text
~/.cc-switch/dsh_relay_state.json
```

Windows 上通常展开为 `C:\Users\<用户>\.cc-switch\dsh_relay_state.json`；目录来自 `config::get_app_config_dir()`，App Store 版可以覆盖该目录。文件内容为：

```json
{
  "attached": true,
  "baseUrl": "http://127.0.0.1:<本地代理端口>",
  "providers": []
}
```

`providers` 保存每个 provider 的原始和中转地址关系。状态文件使用私有权限并原子写入。

开关本身保存于：

```text
~/.cc-switch/settings.json
```

字段是 `dshRelayEnabled`（默认 `false`，保持“不主动改动用户地址”的默认行为）和 `dshRestoreOnExit`（默认 `true`）。设置查询和变更的前端实现位于 `src/lib/query/dsh.ts` 与 `src/lib/api/dsh.ts`。

## 生命周期与启动自愈

1. **开启中转**：读取并保存每个 provider 的原始 `baseURL`，再将 DSH provider 地址改成对应的本机 `/dsh/<providerId>` 地址。已有中转地址不会被误记为新的原始地址。
2. **运行期间**：DSH 请求进入本机中转，再按侧车状态中的原始地址转发；统计和观察在 CCS 侧完成。
3. **正常退出**：如果 `dshRestoreOnExit` 和 `attached` 都为真，逐条把 provider 的 `baseURL` 写回原始地址，并清空侧车状态。
4. **崩溃或强杀**：退出钩子来不及执行时，侧车文件保留 `attached = true`。下次启动由 `heal_on_startup` 处理，不依赖上一次进程正常退出。
5. **启动时以设置开关为准**：
   - `dshRelayEnabled = true`：启动即自动接管，按当前本地代理端口重写地址，绝不把中转地址记成原始地址。
   - `dshRelayEnabled = false` 且侧车仍为 `attached = true`：启动时还原原始地址并清理中转状态。
   - 没有有效的中转状态：不修改 DSH 配置。
6. **关闭中转开关**：按已保存的原始地址恢复 provider 配置；退出还原开关则决定正常退出时是否继续执行同样的恢复动作。

## 退出行为表

| 场景 | 中转设置状态 | 事件 | 结果 |
| --- | --- | --- | --- |
| 正常运行后退出 | `dshRelayEnabled=true`、`dshRestoreOnExit=true`、已附加 | 用户主动退出 CCS | 逐条恢复原始 `baseURL`，清空侧车文件；DSH 继续直连 |
| 运行中异常终止 | 中转已附加，退出钩子未执行 | 崩溃或强杀 | 侧车保留 `attached=true`；下次启动按 `heal_on_startup` 自愈 |
| 中转开关关闭 | `dshRelayEnabled=false`，但侧车仍 `attached=true` | CCS 启动 | 按侧车记录还原原始地址，再清理中转状态 |
| 中转开关开启 | `dshRelayEnabled=true` | CCS 启动或运行期间 | 按当前端口自动接管；使用本机中转，退出时是否还原由 `dshRestoreOnExit` 决定 |

“退出还原”只描述用户主动退出 CCS 时的地址恢复，不代表 DSH 进程退出，也不改变 DSH 自己的 provider、凭据或当前模型管理方式。

## 为什么不做成 `PROXY_APPS` 成员

`PROXY_APPS` 是 CC Switch 现有应用级代理堆栈的集合。DSH provider 同步和当前模型选择由 DSH 原生配置负责；DSH 中转只是在 provider 地址层增加一个可选的本机入口。把 DSH 加入 `PROXY_APPS` 会把它误当作已有的应用级代理接管对象，可能触发不适用的堆栈切换、退出逻辑和故障转移行为。

因此 DSH 使用独立的 relay 状态、独立的 `dsh_*` 命令和独立的设置区。前端开关调用 `dsh_set_relay` 与 `dsh_set_restore_on_exit`，状态查询调用 `dsh_relay_status`；这些命令不依赖 `PROXY_APPS` 的应用开关。

## 操作步骤

1. 确认 DSH provider 已经可以直连工作，并保存当前配置。
2. 打开设置中的 DeepSeek Harness 区域。
3. 打开“DSH 中转”，确认状态区域显示本机中转地址和 provider 的地址映射。
4. 需要退出 CCS 后继续让 DSH 直连时，保持“退出 CCS 时恢复原始地址”开启。
5. 退出 CCS 后重新检查 DSH provider 的 `baseURL`，应恢复到开启中转前保存的原始地址。
6. 如果状态不可用，先保持开关关闭并检查 CCS 日志、DSH 配置权限和本机端口占用。

## 故障降级

设置页读取中转状态失败时，不会重试或盲目写配置，而是显示状态不可用并禁用两个开关。中转启动或某个 provider 更新失败时，应保留可识别的错误，不能用空地址覆盖 provider。请求转发失败时，DSH 看到对应的上游错误；CCS 不改写响应 JSON。

多个 CCS 实例、外部同时修改 DSH provider、原始地址缺失和端口占用需要按实际运行环境排查。启动自愈负责处理崩溃和强杀留下的 attached 状态。

## 实测结果（`4.0.14-dsh.3`）

还原后的状态只在 CCS 不在运行时存在，所以用三段脚本在真实进程上验证（`ccswitch-dsh-exit-smoke.cjs`，全部通过）：

1. **`attach-exit`**：开中转后 6 个 provider 的地址都被改写成 `http://127.0.0.1:15721/dsh/<providerId>`；随后走与托盘退出相同的 `plugin:process|exit` 路径退出，进程结束后 `cordis.patch.yml` 与开启前的备份**逐字节一致**（13,930 B、0 处 `/dsh/` 残留），侧车变成 `{"attached":false,"baseUrl":null,"providers":[]}`。
2. **`verify-restart`**：重启 CCS 后不需要任何点击，`dshRelayEnabled=true` 即自动重新挂载同样的 6 个 provider；再次退出仍然逐字节还原。
3. **`restore-switch`**：把开关和 `dshRestoreOnExit` 恢复成测试前的值（`relayEnabled=false`、`restoreOnExit=true`），退出后 patch 依旧与备份一致，现场不留痕迹。

