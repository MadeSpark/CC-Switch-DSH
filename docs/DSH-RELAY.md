# DSH 中转与退出还原

DSH 中转把 DSH provider 的请求先送到 CC Switch 本机，再由 CC Switch 按原始地址转发。它的作用是为请求提供统一观察和统计入口，同时保留 DSH 自己管理 provider、凭据和当前模型的职责。准确的生命周期语义是：**CC Switch 运行期间中转，退出时按设置还原成直连**。

## 入口在哪

`4.0.14-dsh.4` 起，中转入口从设置页迁到 DeepSeek Harness 应用页；`4.0.14-dsh.5` 起，页头改成 Claude Code 同款分段控件（圆角分组 `直連 | 路由` + `?` 说明 + 生效状态行）；`4.0.14-dsh.6` 起，分段控件只切换视图、不再直接开关中转——页头右侧那个重复的快捷开关已删除，真正的开关是列表上方的提示条按钮：

- **「直连」**（繁中界面为「直連」）：原来的供应商列表，直接读写 DSH 自己的 provider 配置；它和 CC Switch 中转无关。
- **「路由」**：和「直连」渲染同一份 provider 列表（同样是加法式列表，卡上只有「加入 / 移除」，当前 provider 不可移除），页头的「新增供應商」和搜索按钮在这个视图下同样可用；区别只在于已被本机中转接管的卡片会显示绿色「路由中」徽标和绿色卡片底色。

两个 pill **只切换正在查看的视图，点击不写任何配置**；**实际生效**的状态由状态行文字给出（`attached` 为真时显示「路由生效中 → \<provider\>」，否则显示直连的「\<供应商\> · \<模型\>」）。当「正在查看的视图 ≠ 当前生效状态」时，列表上方会多出一条提示，标题形如「你在查看「路由」，DeepSeek Harness 目前是直連。」，右侧按钮是「開始路由」或「回到直連」——**只有点它才真正 attach / detach 中转并弹 toast**。视图与生效状态一致时提示条不出现。

因此操作上一律走“侧栏选 DeepSeek Harness → 切到「路由」→ 点列表上方提示条的「開始路由」”。设置页不再有「DSH 中转」分组；旧版本在本地存过 `section: "dsh"` 的，会落到设置页的「本地路由」分组。

## 工作方式

开启 DSH 中转后，DSH provider 的 `baseURL` 会被改写为：

```text
http://127.0.0.1:<本地代理端口>/dsh/<providerId>
```

DSH 后续追加的 `/v1/messages`、`/v1/responses` 等路径会原样拼回原始地址。请求路径、查询参数、请求体和响应体按字节流透传；SSE 等流式响应也不重写 JSON。这样 DSH 收到的 `usage.inputTokens`、`usage.cacheReadTokens` 等字段保持原样。

每个 provider 需要同时保留两类地址：

- 原始直连地址：用户在 DSH provider 中配置的 API 地址。
- 中转地址：由本机监听端口和 `/dsh/<providerId>` 路径组成的地址。

「路由設定」sheet（「路由」视图且中转已生效时，模式行右端出现齿轮图标）会显示中转是否已附加、本机中转地址、每个 provider 的“原始地址 → 中转地址”关系，以及刷新按钮和说明文字；中转开关不在这个 sheet 里。前端状态接口模型位于 `src/lib/api/dsh.ts` 的 `DshRelayProvider` 和 `DshRelayStatus`。

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

开关值本身保存于：

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
6. **关闭中转**（列表上方提示条上的「回到直連」）：按已保存的原始地址恢复 provider 配置；退出还原开关则决定正常退出时是否继续执行同样的恢复动作。

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

因此 DSH 使用独立的 relay 状态、独立的 `dsh_*` 命令和独立的页面入口（DeepSeek Harness 应用页的「路由」视图，不占用设置页分组）。前端由列表上方的提示条按钮和「路由設定」sheet 调用 `dsh_set_relay` 与 `dsh_set_restore_on_exit`，状态查询调用 `dsh_relay_status`；这些命令不依赖 `PROXY_APPS` 的应用开关。

## 操作步骤

1. 确认 DSH provider 已经可以直连工作，并保存当前配置。
2. 侧栏选中 DeepSeek Harness，先停在「直連」确认列表里的供应商能正常直连。
3. 点分段控件里的「路由」——这一步只切视图，不写任何配置；列表还是同一份 provider，因为当前生效的是直连，列表上方会出现提示条「你在查看「路由」，DeepSeek Harness 目前是直連。」。
4. 点提示条右侧的「開始路由」才会真正接管中转并弹 toast；随后列表里被接管的卡片出现绿色「路由中」徽标（绿色卡片底色），状态行显示「路由生效中 → \<provider\>」。
5. 需要看地址映射或改退出还原时，点模式行右端的齿轮「路由設定」，在右侧 sheet 里看状态区（是否接管、本机中转地址、每个 provider 的原始 → 中转地址）、点刷新，或切换「退出 CC Switch 時自動還原直連位址」。
6. 需要退出 CCS 后继续让 DSH 直连时，保持「退出 CC Switch 时自动还原直连地址」开启。
7. 退出 CCS 后重新检查 DSH provider 的 `baseURL`，应恢复到开启中转前保存的原始地址。
8. 如果状态不可用，提示条按钮是 disabled、齿轮里的状态区显示不可用，此时不会写配置；先检查 CCS 日志、DSH 配置权限和本机端口占用。

## 故障降级

「路由」读取中转状态失败时，不会重试或盲目写配置，而是显示状态不可用：列表上方提示条右侧的「開始路由 / 回到直連」按钮置为 disabled，「路由設定」sheet 里的状态区显示不可用（齿轮 sheet 不再提供任何写入入口）。中转启动或某个 provider 更新失败时，应保留可识别的错误，不能用空地址覆盖 provider。请求转发失败时，DSH 看到对应的上游错误；CCS 不改写响应 JSON。

多个 CCS 实例、外部同时修改 DSH provider、原始地址缺失和端口占用需要按实际运行环境排查。启动自愈负责处理崩溃和强杀留下的 attached 状态。

## 写入可靠性（`4.0.14-dsh.7`）

改 `cordis.patch.yml` 要和 DSH 的配置监听（chokidar `awaitWriteFinish`）、杀软和索引器抢文件句柄，Windows
上表现为 `os error 32`（读被独占）或 `1175`（替换时删不掉目标）。`dsh.7` 起这条路径按三条不变式做：

1. **先记账再改文件**：侧车里的原始地址总是先落盘，之后才动 patch 层；改成功后账本也不清空，降级成
   「原始地址台账」，所以任何一次失败都还照着它换回来。
2. **写操作自己扛住争用**：替换失败按 20/40/…/160 ms 退避重试 8 次；仍然失败就原地重写
   （`OpenOptions` + `truncate` + `write_all` + `sync_all`），绕开「删不掉要替换的文件」这条路径；每次写前
   留 `.ccswitch.bak` 备份。读配置同样退避重试 6 次，一次读失败不再让「切回直連」直接报错。
3. **以回读的文件为准**：恢复最多 3 轮「写 → 回读」，只有文件里真的不再是 loopback `/dsh/` 地址才算还原；
   读失败按「还没换回来」处理并继续重试，不会当成成功。

判定同样不看账本里的字符串：只要当前值是 loopback 主机 + `/dsh/` 前缀就换回，原始地址按
「台账 → 数据库 → `.ccswitch.bak` → `~/.dsh/recovery/`」四级兜底。退出钩子和启动自检都基于文件事实
（账本 `attached` **或** 文件里还有中转地址），所以崩溃留下的死端口地址会在下次启动时修掉。
真换不回来时（例如某个进程把文件锁超过约 1.5 s），界面给「N 个 provider 的地址还没换回原始直连地址」的
警告并保留台账，不做成功提示，下次启动或退出继续重试。

## 实测结果（`4.0.14-dsh.3`）

还原后的状态只在 CCS 不在运行时存在，所以用三段脚本在真实进程上验证（`ccswitch-dsh-exit-smoke.cjs`，全部通过）：

1. **`attach-exit`**：开中转后 6 个 provider 的地址都被改写成 `http://127.0.0.1:15721/dsh/<providerId>`；随后走与托盘退出相同的 `plugin:process|exit` 路径退出，进程结束后 `cordis.patch.yml` 与开启前的备份**逐字节一致**（13,930 B、0 处 `/dsh/` 残留），侧车变成 `{"attached":false,"baseUrl":null,"providers":[]}`。
2. **`verify-restart`**：重启 CCS 后不需要任何点击，`dshRelayEnabled=true` 即自动重新挂载同样的 6 个 provider；再次退出仍然逐字节还原。
3. **`restore-switch`**：把 `dshRelayEnabled` 和 `dshRestoreOnExit` 恢复成测试前的值（`relayEnabled=false`、`restoreOnExit=true`），退出后 patch 依旧与备份一致，现场不留痕迹。

另在退出后单独跑一次 `check-after-exit` 复核：patch 里 0 条 `/dsh/` 地址残留。

## 实测结果（`4.0.14-dsh.7`）

同上三阶段脚本在 dsh.7 上重跑（`attach-exit` → `verify-restart` → `check-after-exit`，全过）：

- 接管 5 家 → 走 `plugin:process|exit` 退出 → patch 与开启前备份**逐字节一致**（13,300 B、0 处 `/dsh/`），
  侧车 `attached=false` 且保留 5 条原始地址台账；重启后不需要任何点击又自动接管 5 家，再退出仍然逐字节还原。
- 应用页手动切回「直連」：`dsh_set_relay{enabled:false}` 105 ms 返回，5 家 `relayed=false`，地址逐个变回原始值。
- 争用对照（`ccswitch-dsh-contention-smoke.cjs`，用 `FileShare.None` 独占锁住 patch 层 500 ms 后再切）：
  dsh.7 在 653 ms 后成功、0 条残留且与备份逐字节一致；同一把锁下 dsh.6 9 ms 就失败（`os error 32`）并把
  5 条 `/dsh/` 地址留在文件里——这就是用户报的那个回归。

