# WeMail 离线 NSIS 安装包运行时依赖精简设计

## 背景

WeMail `0.1.1` 的桌面构建和解压版打包已经成功，`dist/win-unpacked/WeMail.exe` 可以生成并通过现有烟测。但 electron-builder 在最后封装单文件离线 NSIS 安装器时稳定失败：

```text
Internal compiler error #12345: error creating mmap the size of 221344520.
```

当前解压内容约 777 MB，NSIS 应用归档约 195 MB。打包脚本使用根 `package.json` 的全部 `dependencies` 执行 `bun install --production`，因此把已由 Vite 打入 renderer bundle 的 React、Radix、Tiptap、图标、Mermaid 及其他前端依赖再次复制到桌面运行时。较大的重复依赖包括约 80 MB 的 Mermaid、31.5 MB 的 Phosphor 图标和 22.5 MB 的 TypeScript。

切换 NSIS ZIP 压缩并不能解决问题。长期修复必须缩小桌面运行时依赖，而不是依靠机器剩余内存、反复重试或更换压缩参数。

## 目标

- 保留单个、可离线使用的 x64 NSIS 安装包。
- 保持用户命令 `npm run package:desktop:installer` 不变。
- 只将 Electron 主进程和本地服务实际需要的第三方依赖放入生产包。
- 在进入耗时的复制和 NSIS 阶段前发现缺失的运行时依赖。
- 对生产依赖和安装包体积设置自动门禁，防止前端依赖重新进入生产包。
- 保留原生 SQLite ABI 处理、解压版启动烟测、品牌图标和版本信息。

## 非目标

- 不改为 Web Installer、在线下载器、MSI 或便携压缩包。
- 不在本次整体 bundle Electron 主进程和服务端代码。
- 不升级第三方依赖版本。
- 不修改应用功能、数据库结构、用户数据目录或自动更新协议。
- 不以关闭杀毒软件、扩大分页文件或重启机器作为正式解决方案。

## 方案选择

采用“重分根依赖边界 + 自动运行时审计 + 体积门禁”的方案。

### 备选方案一：独立运行时 package.json

在 `packaging/runtime-package.json` 中维护生产依赖可以避免调整根依赖分类，但会复制包名和版本。依赖升级时根清单与运行时清单容易失配，因此不采用。

### 备选方案二：bundle 主进程与服务端

使用 esbuild 等工具将绝大多数 Node 依赖打入少数文件，只 external 原生模块，理论上体积最小。但动态导入、PDF 资源、Agent/MCP 扩展和原生模块会扩大兼容验证范围，不适合作为本次安装器故障的第一修复，因此不采用。

### 选定方案：标准依赖分类

根 `package.json` 的 `dependencies` 定义桌面应用运行时依赖，`devDependencies` 定义构建、测试以及已打入 renderer bundle 的依赖。打包脚本继续使用 `bun install --production`，但生成的生产目录只包含真正的 Node/Electron 运行时依赖及其传递依赖。

## 依赖分类

### 保留在 dependencies

保留 Electron 主进程、本地 API、邮件同步、AI/Agent、目录、PDF、加密和更新功能在运行时直接加载的包，例如：

- `@hono/node-server`、`hono`、`@react-router/node`；
- `better-sqlite3`；
- `imapflow`、`nodemailer`、`postal-mime`；
- `pdf-parse`；
- `jose`、`sm-crypto`、`pinyin-pro`；
- `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`；
- `electron-is-dev`、`electron-updater`；
- 其他经编译产物审计确认由桌面运行时加载的包。

最终清单以编译产物的可达依赖审计结果为准，不以人工示例列表为唯一依据。

### 移动到 devDependencies

移动只参与 renderer 构建、样式处理、测试或开发工具链的包，例如：

- React、React DOM、TanStack Query；
- Radix UI、Tiptap、Phosphor Icons；
- Tailwind、React Router 构建工具和 Vite 相关依赖；
- renderer 专用的样式、内容展示和交互依赖；
- TypeScript、测试框架、Electron 构建工具。

版本范围保持不变，只改变分类。修改后使用 Bun 更新 `bun.lock`，并确保锁文件在 `--frozen-lockfile` 模式下可复现安装。

## 运行时依赖审计

新增一个独立脚本，在 `build:desktop` 完成后、生产依赖复制前运行。

审计以 `dist-electron/electron/main/app.js` 为入口，递归读取本地编译模块中的静态 `import`、动态 `import()` 和 CommonJS `require()`。对每个非 Node 内置、非 `electron`、非本地相对路径的包：

1. 归一化为顶层包名，包括作用域包。
2. 检查该包是否声明在 `dependencies` 中。
3. 检查该包能否从生产依赖缓存目录解析。
4. 对动态构造而无法静态识别的运行时模块提供显式 allowlist，并在代码中说明原因。

缺失时输出引用文件、包名和修复提示，立即终止打包。该审计不扫描测试文件、源码 eval 工具或 renderer bundle 内部引用。

## 打包缓存

生产依赖缓存键继续包含：

- `package.json` 的 `dependencies`；
- `overrides`；
- `bun.lock` 内容；
- 运行时审计脚本版本或缓存格式版本。

依赖重新分类后缓存键自然变化，不能复用当前臃肿缓存。缓存目录只有在冻结锁文件安装成功、审计成功且原生依赖准备完成后才写入 `.ready`。

不再复用仅比较依赖 JSON 的旧版 legacy 缓存，避免旧缓存绕过新审计和体积门禁。

## 体积门禁

打包脚本在进入 NSIS 前统计并记录：

- 生产 `node_modules` 总大小；
- `dist/win-unpacked/resources/app` 总大小；
- NSIS 应用归档大小；
- 最大的 20 个顶层运行时包。

第一阶段门禁目标：

- NSIS 应用归档低于 150 MB；
- 解压应用内容明显低于当前约 777 MB；
- `typescript`、`@phosphor-icons/react`、Radix、Tiptap 和其他 renderer-only 包不得出现在生产 `node_modules`。

若超过门禁，脚本在调用 `makensis` 前失败，并输出最大的包及其大小。阈值应集中定义，后续根据稳定构建数据调整，而不是散落在脚本逻辑中。

## 打包流程

长期修复后的 `package:desktop:installer` 流程为：

1. 确保 Electron runtime 和 `better-sqlite3` Electron ABI 绑定可用。
2. 在源码变化时执行桌面构建。
3. 使用精简后的 `dependencies` 和冻结的 `bun.lock` 创建生产依赖缓存。
4. 对编译入口和生产依赖执行运行时依赖审计。
5. 复制 Electron runtime、应用产物、生产依赖和品牌资源。
6. 将缓存中的 `better-sqlite3` 原生绑定放入最终运行时位置。
7. 执行解压版文件完整性检查和启动烟测。
8. 执行体积门禁并输出体积报告。
9. 使用 electron-builder 生成单个离线 NSIS 安装器。
10. 验证安装器存在、版本为 `0.1.1` 且大小非零。

## 错误处理

- 冻结锁文件变化：在生产安装阶段前失败，提示更新并提交 `bun.lock`。
- 缺少运行时包：在审计阶段失败，输出引用路径和缺失包。
- 原生 ABI 不匹配：继续由现有 `ensure-electron-native-bindings` 处理，禁止退回 Node ABI 文件。
- 体积超限：在 NSIS 前失败并输出最大依赖列表。
- 解压版启动失败：保留启动日志并停止烟测进程，不生成安装器。
- NSIS 失败：保留应用归档和有效解压版，输出缓存、归档和安装器路径。

## 测试与验收

### 自动测试

- 依赖审计能识别静态 import、动态 import、CommonJS require 和作用域包。
- Node 内置模块、`electron` 和相对路径不会被误报。
- 缺失包错误包含引用文件和包名。
- renderer-only 包出现在生产目录时体积/禁用列表门禁失败。
- 缓存键在 dependencies、overrides、锁文件或审计版本变化时改变。
- legacy 缓存不能绕过新审计。

### 构建验证

- `npm run typecheck:desktop` 通过。
- `npm run typecheck:server` 通过。
- 相关打包脚本测试通过。
- `npm run build:desktop` 通过。
- `npm run package:desktop:dir` 生成可启动的解压版，并完成本地 API 初始化烟测。
- `npm run package:desktop:installer` 生成 `dist/WeMail Setup 0.1.1.exe`。
- 安装器在无网络环境下可以安装并启动 WeMail。
- NSIS 阶段不再出现 `error creating mmap`。

## 完成定义

- 单文件离线 NSIS 安装器稳定生成。
- 生产包不再包含已由 renderer bundle 提供的主要前端依赖。
- 安装器构建在冻结锁文件模式下可复现。
- 运行时依赖漏配和体积回退能在 NSIS 前得到明确错误。
- 当前工作区中与打包修复无关的未提交改动不被覆盖或纳入提交。
