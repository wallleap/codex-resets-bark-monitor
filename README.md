# Codex Resets → Bark 监控

通过 **GitHub Actions 每 30 分钟** 检查 [Codex Resets](https://codex-resets.com/zh-CN) 的公开 API，发现新增公告或预定重置变更后，向官方或自建 Bark Server 发送 iOS 通知。无需服务器、API Key、第三方 npm 包或 GitHub PAT。

> **准确性边界**：这里只监控第三方公开公告，并非你个人账户的 5 小时/每周额度。`scheduled_reset.scheduled_for` 可能表示最晚参考时间而不是执行时刻；`active_watch` 是预测，不会作为确定重置推送。计划从来源消失也不能直接判定为「已取消」或「已兑现」。

## 1. 创建 GitHub 仓库

建议新建 **私有仓库** `codex-resets-bark-monitor`，将本项目整个目录上传到默认分支（例如 `main`）。如果是从 ZIP 下载：先解压，再上传 **目录里面的文件**，确保 `.github/workflows/monitor.yml` 位于仓库根目录的相同路径。

通过 Git 在本地推送的示例（替换 `<owner>`）：

```bash
git init
git add .
git commit -m "feat: monitor Codex Resets with Bark"
git branch -M main
git remote add origin git@github.com:<owner>/codex-resets-bark-monitor.git
git push -u origin main
```

## 2. 配置 `server_url` 和 `device_key`（不要写死）

进入 GitHub 仓库 → **Settings → Secrets and variables → Actions**，分别设置：

| GitHub 配置类型 | 名称 | 示例或说明 |
|---|---|---|
| **Variable**（Variables → New repository variable） | `BARK_SERVER_URL` | `https://api.day.app`，也可以是 `https://bark.example.com` |
| **Secret**（Secrets → New repository secret） | `BARK_DEVICE_KEY` | 从 Bark App 中复制设备推送 Key；**不要公开** |

工作流将这两个配置传入 Node.js 进程环境变量（注意分别对应）：

```yaml
env:
  SERVER_URL: ${{ vars.BARK_SERVER_URL }}
  DEVICE_KEY: ${{ secrets.BARK_DEVICE_KEY }}
  TIME_ZONE: Asia/Shanghai
```

- `SERVER_URL` 是 Bark 服务的**基础地址**，不要填 `/push`，不要拼入设备 Key；程序自动发送 `POST ${SERVER_URL}/push`。
- `DEVICE_KEY` 在 JSON 请求体 `device_key` 字段传递，**不写入 URL、源码、日志或 Git 状态文件**。
- **自建 Bark 服务必须有公开可访问的 HTTPS 地址**。GitHub 托管运行器通常无法访问你家里的 `localhost`、局域网 IP 或仅在 VPN 内开放的服务器。建议配置反向代理与 TLS。
- 如果你不希望公开自建域名，也可将工作流 `SERVER_URL: ${{ vars.BARK_SERVER_URL }}` 改为 `SERVER_URL: ${{ secrets.BARK_SERVER_URL }}`，并在 **Secrets** 中创建 `BARK_SERVER_URL`。
- 设备 Key 属于敏感凭据。避免截图、日志和公开提交中泄露；更换 Bark Key 后只需更新 GitHub Secret。

官方 Bark 支持 `/push` JSON、`device_key`、`title`、`body`、`group`、`url` 等参数：<https://github.com/Finb/Bark/blob/master/docs/tutorial.md> 。

## 3. 检查 GitHub Actions 权限

仓库 **Settings → Actions → General**，确认：

1. Actions 已启用。
2. 工作流有向仓库推送变更的权限（本项目使用工作流里的 `permissions: contents: write`）。如果报 `403 Permission denied`，检查仓库和组织的 Workflow permissions 限制及分支保护规则。
3. **无需个人 PAT**，`actions/checkout` 使用自动生成的 `GITHUB_TOKEN`。本项目只更新 `.data/state.json`，并且 GitHub Token 的提交不会形成反复触发 `push` 工作流的循环。

**重要**：如果你使用了不允许 GitHub Actions 推送的受保护默认分支，需要调整分支规则或改用可写的状态分支；否则程序可以推送 Bark，但跨运行去重状态将无法保存，可能重复通知。

## 4. 首次运行和测试

在仓库 **Actions → Codex Resets -> Bark → Run workflow**，务必选择仓库**默认分支**（例如 `main`；其它分支会被工作流跳过）：

1. 先勾选 `test_push = true`，点击运行。手机应收到「Codex Resets 监控测试」。**不建立或修改去重状态。**
2. 再运行一次，保持 `test_push = false`，这次只建立 `.data/state.json` **基线**，不会补发几十条旧历史通知。
3. 后续定时运行时，有真正的新公告或计划变更才通知；无变化时不产生新的 Git 提交。

工作流默认北京时间显示。修改 `monitor.yml` 的 `TIME_ZONE` 可使用其它 IANA 时区，例如 `America/Los_Angeles` 或 `UTC`。工作流本身的 cron 按 UTC 执行，默认 **每小时 UTC 的 11 分和 41 分**。

## 5. 工作原理

### 读取的接口

- `GET https://codex-resets.com/api/v1/status`：解析 `data.scheduled_reset`。
- `GET https://codex-resets.com/api/v1/resets?limit=100`：解析 `data[]` 中 `id`、`reset_type`、`announced_at`、`text` 和 `source.url`。

轮询频率固定为 **30 分钟**。如果接口无法连接、JSON 结构异常、历史为空等，会报错并保持之前状态，避免误报。

### 去重、计划变化和失败恢复

- 首次运行：将现有历史 ID 和当前计划写入 `.data/state.json`，不推送旧记录。
- 后续公告：用历史 ID 集合识别新增记录；只在 Bark 返回 HTTP 2xx **且 JSON `code=200`** 后记录成功的 ID。
- 计划：只比较计划 `id / scheduled_for / day / when_text / text / announced_at / type / status / URL` 等稳定字段，不比较滚动倒计时、更新时间或预测值；增加、改期、内容变化、消失时发送通知。
- 当有新历史记录的同时计划消失，会避免再次发送「计划不再显示」，以减少重复提醒；这不代表它一定已兑现。
- 只在状态发生实质变化时，GitHub Actions 才会提交 `.data/state.json`。
- Bark 推送部分成功、随后一条失败：程序**逐条落盘**。GitHub Actions 即使发现 Node 任务失败，也尝试提交之前的成功状态；下次只重试未成功的记录。
- 429、服务器 5xx、连接超时可有限重试，最多 3 次；遵循短 `Retry-After`。若服务端要求等待超过 15 秒，则本次放弃，交给下一个 30 分钟调度执行，避免长期占用 Actions 资源。

**交付语义是至少一次（at-least-once），不能保证绝对恰好一次。** 例如 Bark 已接收推送，但网络在确认响应前中断；或者推送成功但 Git 提交失败，之后重试可能重复。真正跨网络的 exactly-once 需要 Bark 服务端支持幂等键/事务，单靠文件去重做不到。

### 日志与故障排查

日志在 **Actions → 对应工作流运行 → Check data and send Bark / Persist state** 中查看：

- `首次初始化`：首次记录基线，无通知。
- `检查完成 ... 0`：无变化，不提交。
- `公告已推送并保存`：成功通知。
- `监控失败：HTTP 429 / HTTP 5xx`：上游失败、限流或 Bark 失败；下次重试。
- `监控失败：状态 API 缺少 ...`：上游接口协议变化，需要更新解析代码；状态不会清空。
- `git push` 失败：检查 `contents: write`、分支保护和是否有其他提交冲突。

为了避免刷屏，本项目**不会每 30 分钟额外发送一次健康通知**；失败只在 GitHub Actions 日志中体现，可使用 GitHub 自带的工作流失败通知邮件提醒。

## 6. 本地运行和测试（可选）

需要 Node.js 22+。无需 `npm install`，没有第三方依赖。

```bash
cp .env.example .env
# 编辑 .env，设置真实 SERVER_URL 和 DEVICE_KEY；.env 已被 gitignore
node --env-file=.env src/monitor.mjs --test-push
node --env-file=.env src/monitor.mjs
node --test
```

本地默认去重文件也是 `.data/state.json`；它会被本地 Git 识别为未提交变更。**不要把自己的测试状态直接替代生产状态**；最好在另一个目录单独测试，正式运行以 GitHub Actions 上的基线为准。

## 7. 资源消耗与注意事项

- 每天 48 次，每 30 天 **1,440 次** GitHub Actions 调度。私有仓库标准运行器实际用量仍以 GitHub 当前计费/运行时规则为准；若按每次最低 1 分钟估算，约 1,440 计费分钟/月（不含手动运行或超时）。
- 没有 `npm install`、没有拉取大量依赖，也不会在无变化时写 Git。`timeout-minutes: 3` 限制异常执行时间。
- 运行计划可能延迟或被 GitHub 丢弃；长期无活动的公开仓库计划任务也可能被停止，不能承诺实时提醒。
- 如果想停止，请在 GitHub Actions 页面禁用工作流，或删除 `.github/workflows/monitor.yml`。
- 第三方网站及 API 随时可能改变。当前方案有离线测试保证程序行为；**无法在此环境直接连通 codex-resets.com 进行线上端到端验收**。首次在 GitHub Actions 中执行时请核对真实 API 的兼容性。

## 8. 项目结构

```text
.
├── .github/workflows/monitor.yml  # 每 30 分钟的计划任务、手动测试、持久化
├── .data/.gitkeep                # 数据目录占位
├── src/http.mjs                 # HTTP/429重试、Bark POST
├── src/monitor.mjs              # 公告和预定计划监控、状态去重
├── test/monitor.test.mjs        # 离线集成测试
├── .env.example                 # 本地环境变量示例
├── .gitignore
├── package.json
└── README.md
```

参考资料：

- 数据网站：<https://codex-resets.com/zh-CN>
- 字段说明及时间含义交叉验证：<https://tibo.cc/guide/api>
- Bark JSON 推送：<https://github.com/Finb/Bark/blob/master/docs/tutorial.md>
- GitHub Actions 工作流语法：<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- GitHub `GITHUB_TOKEN`：<https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
