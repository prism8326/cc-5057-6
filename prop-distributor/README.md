# 道具分布 · 关卡编辑视窗（prop-distributor）

程序化道具分布编辑器：密度场 + 坡度/材质约束 + 声明间距 + 净空分析，带稳定实例身份、
表面锚点与可迁移的**分布资产**格式（v2）。

## 图形入口（主要入口）

```bash
npm start          # 启动本地服务
# 浏览器打开 http://localhost:8017
```

关卡编辑视窗（图形界面）是道具分布的**主要入口**。它提供：

- 场景 / 地形种子 / 布局种子选择，模式切换（锁住路标 / 只固定地形种子）；
- 每类道具的密度倍率、窄路高密度情景、推车净空与"挪动 vs 重采样"策略对比；
- 顶视图约束/密度热图、采样过程回放、统计核验、净空报告；
- **分布资产状态**面板：显示当前读取的分布资产版本、实例存储版本、表面版本，
  以及身份唯一性、锚点校验与重叠检查结果（异常以红色标出）；
- 操作：拖拽旋转、滚轮缩放、点击路标查看关联实例；Shift+点击地面手动放置道具
  （走与采样器相同的声明约束过滤，成功写入分布资产的"人工覆盖"记录）。

界面里生成、手动放置、以及两种净空策略的应用，都会落盘到分布资产（v2），
再把资产的锚点/世界坐标交给渲染与统计入口 —— 编辑器与渲染读取的是**迁移后**的数据，
而不是采样器的原始输出。

## 分布资产格式（v2）

一条实例记录：

```json
{
  "instanceId": "road-tree-12",           // 稳定身份，跨种子/迁移保留
  "type": "tree",
  "yaw": 1.23,
  "scale": 1.1,                          // 始终为正
  "mirrored": false,                     // 镜像用显式标志，绝不为负缩放
  "surfaceAnchor": { "surfaceId": "road", "u": 20.1, "v": 1.0, "offset": 0, "surfaceVersion": 2 },
  "world": { "x": -10.4, "y": 0.2, "z": 0.3 },
  "locked": false,
  "manualOverride": false
}
```

- `surfaceAnchor`：表面自身坐标系中的锚点（u=弧长，v=带符号横向偏移，offset=离地高度）。
- `world`：由锚点推导出的地面世界坐标；锚点可精确回投到它（`validateDistributionAsset` 校验）。
- `mirrored`：镜像仅影响渲染网格；中心占地（净空/间距计算）不变。

### 迁移边界：世界锚点 vs 保留的旧局部坐标

`migrateDistribution` 用**一个边界**区分 v1 记录的两种来源（`ANCHOR_COINCIDENCE_EPS = 1e-3 m`）：
把记录里的局部锚点在**当前表面**上重投影，与它烘死的世界坐标比较 ——

- 偏差 ≤ 边界：该记录已被**预先转成世界锚点**，原样复用世界坐标；
- 偏差 > 边界：该记录仍持有**旧局部坐标**，世界坐标不可信，按局部坐标重投影到新表面。

面模型换版（`surfaceVersion` 变化）后，烘死的世界坐标会越过边界而被判定为旧局部坐标，
从而被适配而非盲目复用；无法在新的表面定位的记录进入 `report.unresolved`，由转换器指出，
不会静默丢弃。位置偏差逐实例记录在 `report.deviations`（`DEVIATION_WARN = 0.5 m` 为复核阈值）。

镜像缩放（v1 负 `scale`）：迁移后变为正 `scale` + `mirrored` 标志，并逐实例校验
`clearanceRadiusPreserved` 与 `traversabilityRestored` 均能还原。

## 命令行（辅助入口）

命令行仅辅助道具分布的批量/脚本化操作；日常编辑走上面的图形入口。

```bash
# 采样一个场景，写出 v2 分布资产
node tools/distribution.mjs sample --scene road --layout-seed 11 --out asset.json

# 迁移旧资产（自动识别世界锚点 / 旧局部坐标 / 镜像缩放 / 无法定位记录）
node tools/distribution.mjs migrate --in legacy.json --scene road \
  --surface-version 2 --out migrated.json --report report.json

# 校验分布资产：身份唯一、锚点可回投、无重叠
node tools/distribution.mjs verify --in migrated.json --scene road
# 等价的 npm 脚本：npm run dist:sample / dist:migrate / dist:verify
```

`--scene`：`plane` / `slope` / `strip` / `road`；`--surface-version` 默认为 1，
升高它即模拟一次表面几何编辑。退出码：0 成功，1 输入非法 / 校验失败，2 用法错误。

## 版本说明（实例存储换版）

路标身份存储由 v1 升到 **v2**（`STORE_VERSION = 2`）。键名带版本：
`signposts:v2:<sceneId>`；旧的 `signposts:<sceneId>` 在读取时原地迁移（保留 `signpostId`
与 `instanceId`，负缩放转正 + 镜像标志），并写回 v2 键。迁移事件在界面日志中注明。

## 测试

```bash
npm test
```

覆盖：分布资产序列化/校验、迁移边界（世界锚点 vs 旧局部坐标）、表面换版的位置偏差、
镜像缩放与净空/可通行性还原、无法定位记录的报告、人工覆盖保留、实例存储 v1→v2。
