# ChatGPT Exporter

Forked from [huhusmang/ChatGPT-Exporter](https://github.com/huhusmang/ChatGPT-Exporter).

一个用于批量导出 ChatGPT 对话记录的工具，支持个人空间（仅项目外）、团队空间（项目外 + 项目内）与项目对话（仅项目内）的导出，可输出为 JSON 或 Markdown，并提供导出全部、选择对话导出、Q&A 轮次导出等多种方式，适配不同备份与整理需求。

## 功能特性

- 📦 支持导出全部对话，适合一次性全量备份
- ✅ 支持选择对话导出，适合按关键词、项目、归档状态、日期范围精准筛选
- 💬 支持单条对话内的 Q&A 轮次导出，适合只保留重点问答片段
- 🏢 支持个人空间（仅项目外）、团队空间（项目外 + 项目内）、项目对话（仅项目内）
- 📁 项目对话导出自动按项目分组整理，并按项目最近更新时间优先展示
- 📄 支持 JSON 和 Markdown 两种导出格式
- 📝 导出前支持自定义 ZIP 压缩包名称；留空则使用默认命名
- 🔄 自动清理引用标记，并保留 Markdown 脚注信息
- ⏰ 支持定时提醒导出（Chrome 扩展）
- ⚡️ 支持导出 `...更多` 中的隐藏项目，减少项目遗漏
- ⚡️ 优化大量对话加载与筛选性能
- 🗓️ 支持按创建时间/更新时间的日期范围筛选

## 使用方法

本项目提供两种使用方式。当前版本中，Chrome 扩展与 Tampermonkey 在手动导出能力上基本等效，都支持“导出全部 / 选择对话导出 / Q&A 轮次导出 / 自定义 ZIP 名称”。

### 适合什么需求

- **Chrome 扩展**：适合长期使用、希望通过扩展弹窗操作、需要定时提醒导出的用户
- **Tampermonkey 脚本**：适合偏好轻量安装、希望快速上手、只关注核心手动导出能力的用户

### 导出方式一览

- **导出全部**：适合对当前空间做完整备份
- **选择对话导出**：适合按标题、项目、是否归档、日期范围筛选出目标对话
- **选择 Q&A 导出**：适合在单条对话中只导出指定轮次的问答
- **自定义 ZIP 名称**：适合按用途、日期、项目名整理备份包；留空时沿用默认命名逻辑

### 空间分类说明

- **个人空间（仅项目外）**：导出当前个人 workspace 下未进入项目的对话
- **团队空间（项目外 + 项目内）**：导出指定团队 workspace 下的全部对话
- **项目对话（仅项目内）**：导出当前 workspace 下的项目对话，包含 `...更多` 中的隐藏项目，并按项目最近更新时间分组

### 方法一：Chrome 扩展（推荐）

Chrome 扩展适合长期使用，提供完整弹窗界面、定时提醒和更顺手的日常备份体验。

#### 安装步骤

1. 下载 Release 中的 `ChatGPT-Exporter.zip` 到本地
2. 打开 Chrome 浏览器，进入 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目中的 `chrome-extension` 文件夹
6. 安装完成后，扩展图标会出现在工具栏

#### 使用说明

**手动导出：**
- 访问 ChatGPT 网站后，在弹窗中选择空间与导出方式
- 支持“导出全部”“选择对话导出”“选择 Q&A 导出”
- 导出开始前可自定义 ZIP 文件名；留空时使用默认命名
- 选择对话导出支持搜索、项目/项目外筛选、归档筛选、日期范围筛选

**设置定时：**
- 点击扩展图标，进入设置页面
- 配置定时提醒计划（每日、每周等）
- 启用后将在指定时间自动提醒导出

### 方法二：Tampermonkey 脚本

如果不想安装扩展，可以使用 Tampermonkey 脚本。当前版本在手动导出能力上与扩展版基本等效，适合轻量使用。

**[👉 点击这里直接安装脚本 (GreasyFork)](https://greasyfork.org/zh-CN/scripts/569603-chatgpt-universal-exporter-json-markdown-support)**

#### 安装步骤

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击上方安装链接
3. 在弹出的页面中点击 "安装" 即可

#### 手动安装步骤

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `Tampermonkey.js` 文件
3. 复制全部内容
4. 点击 Tampermonkey 图标 → "添加新脚本"
5. 粘贴代码并保存
6. 访问 ChatGPT 网站，脚本会自动运行

#### 使用说明

- 访问 ChatGPT 后，页面右下角会出现 `Export Conversations` 按钮
- 点击按钮后可选择：
  - **个人空间（仅项目外）**
  - **项目对话（仅项目内）**
  - **团队空间（项目外 + 项目内，需要选择具体工作区）**
- 每种空间下都支持“导出全部”“选择对话导出”“选择 Q&A 导出”
- 导出开始前可自定义 ZIP 文件名，不填写则使用默认命名

**相关文件：**
- `Tampermonkey.js` - 完整的用户脚本

## 核心功能说明

### Token 获取
脚本会自动捕获 ChatGPT 的 Access Token 和 Device ID，用于 API 调用认证。

### 对话提取
- 遍历对话的消息树结构（`mapping`）
- 过滤系统消息和隐藏消息
- 清理引用标记（如 `cite` 标签）
- 按时间顺序整理用户和助手的对话

### 文件命名
生成格式：`对话标题_对话ID短码.json/md`
- 自动清理文件名中的非法字符
- 使用对话 ID 后缀避免重名
- 未命名对话使用 "Untitled Conversation"
- ZIP 导出前可自定义压缩包名称；若留空则使用默认命名逻辑

### 导出格式

**JSON 格式：**
完整的对话数据结构，包含所有元数据和消息树。

**Markdown 格式：**
```markdown
# User
用户的问题内容

# Assistant
助手的回复内容
```

## 技术架构

### Chrome 扩展架构
- **Manifest V3**：使用最新的扩展规范
- **Background Service Worker**：处理定时任务和消息传递
- **Content Scripts**：注入页面脚本，与 ChatGPT 交互
- **Popup & Options**：提供用户界面

### 通信机制
1. `inject-exporter.js` 注入 `exporter.user.js` 到页面上下文
2. `auto-export.js` 通过 `postMessage` 与注入脚本通信
3. Background 脚本通过 `chrome.runtime.sendMessage` 触发导出

### API 调用
- `/api/auth/session` - 获取 Access Token
- `/backend-api/conversations` - 获取对话列表
- `/backend-api/conversation/{id}` - 获取对话详情
- `/backend-api/gizmos/snorlax/sidebar` - 获取项目列表与项目会话预览（支持分页补抓隐藏项目）
- `/backend-api/gizmos/{id}/conversations` - 获取项目内的对话列表

## 注意事项

1. **登录状态**：使用前需要登录 ChatGPT
2. **网络请求**：导出过程会发起大量 API 请求，请耐心等待
3. **浏览器限制**：批量下载可能触发浏览器的下载提示
4. **团队空间**：需要有相应工作区的访问权限
5. **Token 有效期**：如果导出失败，尝试刷新页面重新获取 Token

## 常见问题

**Q: 导出时提示"无法获取 Access Token"？**  
A: 刷新 ChatGPT 页面，或打开任意一个对话后再试。

**Q: 团队空间导出失败？**  
A: 确认你有该工作区的访问权限，并且已正确选择工作区 ID。

**Q: 个人空间、团队空间、项目对话有什么区别？**  
A: 个人空间只导出当前个人 workspace 下未进入项目的对话；团队空间会导出指定团队 workspace 下的全部对话；项目对话只导出当前 workspace 下已经进入项目的对话，并会补抓 `...更多` 里的隐藏项目。

**Q: 导出的 Markdown 文件内容不完整？**  
A: 脚本会自动过滤系统消息和隐藏消息，只保留用户和助手的可见对话。

**Q: 可以导出特定时间段的对话吗？**  
A: 支持按创建时间/更新时间的日期范围筛选，可在“选择对话导出”中设置日期区间。

**Q: 可以自定义压缩包名称吗？**  
A: 支持。开始导出前会弹出 ZIP 命名框；如果不填写，则继续使用默认命名逻辑。

## 致谢

本项目核心逻辑基于 [ChatGPT Universal Exporter](https://greasyfork.org/zh-CN/scripts/538495-chatgpt-universal-exporter) (v8.2.0) 开发。

**原作者：** Alex Mercer, Hanashiro, WenDavid

在此基础上，本项目进行了以下增强与封装：
1.  **新增格式支持**：在原有 JSON 导出功能的基础上，增加了 Markdown (.md) 格式的导出支持，方便在笔记软件中直接查看。
2.  **Chrome 扩展封装**：将用户脚本封装为标准的 Chrome 浏览器扩展，提供了独立的配置弹窗和后台运行能力。
3.  **选择对话导出**：新增“选择对话导出”功能，支持搜索/筛选/勾选需要的对话，并导出为 ZIP 文件。
4.  **Q&A 轮次导出与 ZIP 命名**：支持在单条对话中按轮次导出 Q&A，并在导出前自定义压缩包名称。

## 许可证

本项目仅供学习和个人使用，请遵守 OpenAI 的服务条款。

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。
