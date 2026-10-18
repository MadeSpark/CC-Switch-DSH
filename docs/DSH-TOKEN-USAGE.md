# DSH token 消耗统计

本分支会把 DeepSeek Harness 的会话日志导入 CC Switch 的统一用量表，因此即使请求没有经过 CC Switch 本机中转，也可以在历史用量中看到 DSH 会话的 token 使用情况。

## 数据来源与解析方式

默认扫描 `~/.dsh/sessions/**/session.v4.jsonl.zstd`。`DSH_HOME` 改变时，扫描根目录也随之改变。每个会话目录下的 `session.v4.jsonl.zstd` 是追加写入的日志；一次文件可能包含多个独立 zstd frame，导入器会连续解码全部 frame，再按行解析 JSON。

当前识别两类记录：

- `type = "assistant/message"`：从 `data.usage` 读取用量，从 `data.message.source.provider` 和 `data.message.source.model` 读取 provider 与 model。
- `type = "compaction/summary"`：从 `data.usage` 读取用量，从 `data.provider` 和 `data.model` 读取 provider 与 model。

两类记录都需要有效的模型和 provider，且至少包含可计费 token。无法解析的 JSON 行会跳过；没有可计费 token 的记录也不会写入统计表。

导入的字段映射如下：

| DSH 字段 | 统计字段 | 含义 |
| --- | --- | --- |
| `inputTokens` | `input_tokens` | 新产生的输入 token |
| `outputTokens` | `output_tokens` | 输出 token |
| `cacheReadTokens` | `cache_read_tokens` | 从缓存读取的 token |
| `cacheWriteTokens` | `cache_creation_tokens` | 写入缓存的 token |

`inputTokens` 按“新鲜输入 token”处理，缓存命中量单独计入 `cacheReadTokens`，`cacheWriteTokens` 记入 `cache_creation_tokens`。费用会使用 CC Switch 已有的模型价格表；没有价格匹配时仍保留 token 行，但费用为零或待定，具体显示取决于用量页面。

### 计费口径

每条带 usage 的 `assistant/message` 或 `compaction/summary` 记录逐条入库。`inputTokens` 只按新鲜输入计算，`cacheReadTokens` 单独记录，`cacheWriteTokens` 记到 `cache_creation_tokens`。同一条 record 只入库一次；如果上游 retry 各自产生了带 usage 的记录，则每条 retry 各计一条。没有产生 usage 记录的失败尝试不计费。

统一表中的导入行使用以下标记：

- `app_type = "dsh"`
- `data_source = "dsh_session"`
- `provider_id = "_dsh_session"`
- 显示名称：`DeepSeek Harness (Session)`

## 去重与文件游标

每条记录会生成稳定的 request ID：`dsh:<session-id>:<record-id>`。assistant 消息优先使用 `data.message.id`；没有消息 ID 时使用 `seq`。compaction 记录优先使用 `data.compactionId`；没有时使用 `seq`。插入前会按 `request_id + data_source` 查询已有记录，已经导入的记录只计为重复，不会再次增加用量。

导入器还在 `session_log_sync` 中记录文件路径、文件修改时间和文件大小。下一次自动同步如果文件大小和修改时间都没有变化，会跳过整个文件；如果文件有追加内容，则重新读取并依靠 request ID 去重。当前实现是文件级游标，不能把“被原地改写但大小和修改时间未变化”的情况当作可靠增量同步。

现有会话日志同步流程会调用 DSH 导入器（`src-tauri/src/services/session_usage.rs` 的全量同步函数）。启动时会执行一次全量扫描；运行期间由用量页的数据来源抽屉中的“自动同步”开关控制，设置字段为 `sessionAutoSyncEnabled`，默认开启，节奏说明为“每 10 分钟”。

## 开启与验证

1. 打开 CC Switch 用量页，在“数据来源”抽屉中开启“自动同步”开关（字段 `sessionAutoSyncEnabled`）。该设置默认开启，界面显示“每 10 分钟”的同步节奏；CCS 启动时也会执行一次全量扫描。
2. 确认 DSH 已在 `~/.dsh/sessions/` 下生成 `session.v4.jsonl.zstd`，并且当前用户对这些文件和父目录具有读取权限。
3. 让 DSH 完成至少一条 assistant 回复，等待下一次自动同步，或使用现有的手动同步入口。
4. 打开用量统计，查找 `DeepSeek Harness (Session)` 或数据来源 `dsh_session`，核对 model、输入、输出和缓存读取数量。
5. 再次同步同一批文件，记录数量和 token 总数应保持不变；向日志追加新 assistant 记录后再同步，新增记录应只增加一次。

也可以用 `src-tauri/src/services/session_usage_dsh.rs` 中的同步测试夹具验证多 frame 文件、重复记录和追加记录。

## 已知限制与待验证事项

- 历史文件必须可读。权限不足、DSH 使用了不同的 `DSH_HOME`，或日志位于其他目录时，导入器无法补齐数据。
- 统计依赖 DSH 会话日志格式。升级 DSH 后，如果 record type、usage 字段名、zstd 组织方式或目录结构发生变化，需要同步维护解析器。
- 没有产生 usage 记录的失败重试不会进入统计，因此统计不能反映未落日志的失败重试。
- 价格表没有匹配时会写入 token，但费用可能为零；模型别名与实际计费模型的对应关系待验证。
- 文件变更判断使用修改时间和大小。异常的原地覆盖、时钟回拨或文件轮换行为待验证。
- 当前单次同步最多扫描 512 个 session 日志文件；更大的历史目录需要多轮同步。
- 大的 zstd 日志会整体解码后再解析，内存占用与单个日志文件大小相关。

## 实测结果（`4.0.14-dsh.3`）

- 单元测试 `cargo test session_usage_dsh`：5 passed / 1 ignored（ignored 是需要真实语料的用例）。
- 真实语料全量扫描（88 个 `session.v4.jsonl.zstd`、11,820 条记录、0 解析错误、12.355 s）：`request_count=11,820`、`SUM(input_tokens)=105,630,281`、`SUM(output_tokens)=16,100,843`、`SUM(cache_read_tokens)=866,750,547`、`SUM(cache_creation_tokens)=0`、`SUM(total_cost_usd)=192.565240616`、`suspected_duplicates=0`；抽查三条原始记录与入库行，均满足 `inputTokens + outputTokens + cacheReadTokens = totalTokens`。
- 部署版 GUI 冒烟：用量页“数据来源”出现 `dsh_session`（`11,996` 次请求、`$192.769171`），应用筛选条的 DeepSeek Harness 图标可切换，汇总返回 `cacheReadTokens` 与 `cacheHitRate=0.8918`，切到 DSH 过滤后列表正常列出会话日志导入行。

