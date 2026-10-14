# 老年ICU认知电子测评平台

院内研究者指导的单次EMA平台，版本1.0.0-rc.1。技术核查已完成，Xiaomi Pad 6 Pro与Edge的实机验收待研究者完成；验收前使用模拟模式。

- docs/：预构建的完整静态网页，含卡片、固定普通话音频、符号搜索资源及离线缓存。
- source/：可迁移的完整源码、锁文件、测评材料、操作说明及技术核查记录。
- 患者记录仅存当前设备浏览器，由研究者导出ZIP并转存电脑；本仓库不接收患者数据。

流程：三词学习与即时回忆 → 五项症状 → Stroop → 三词延迟回忆 → 12题符号搜索 → 核对导出。

## 发布

仓库Settings → Pages，选择Deploy from a branch、main、/docs，再保存。部署完成后访问：https://qinghuiying1.github.io/icu-cognition-ema/ 。首次联网加载资源，完成平板断网、计时、声音及导出验收后再采集正式资料。

说明：[操作与验收](source/docs/操作与验收.md)、[技术核查](source/docs/技术核查记录.md)、[材料来源](source/docs/材料与证据.md)、[第三方许可](source/docs/第三方许可说明.md)。
