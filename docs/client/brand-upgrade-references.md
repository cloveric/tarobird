# TaroCub 品牌升级：参考与基准

日期：2026-10-02。目标是升级现有桌面/手机 App；保留 Bot—独立对话、群—独立话题的结构。

## 用户确认的参考

- 用户提供的首页图：奶油色、暖金色手绘小狮子、蓝色气泡和动物伙伴。沿用项目原版头像素材，不搬用旧的“飞书专用”产品定位。
- [Grok Bot 官方介绍](https://x.ai/news/introducing-grok-bot)：用户于本次工作中提供。
- [Grok Bot 官方设计文章](https://x.ai/news/designing-grok-bot)：本次实时打开，并操作其工作状态演示。参考持久 Bot 身份、可辨认头像、状态反馈与按需展开的过程。保留自己的配色、动物形象与 session 边界。
- OpenBot 尚无明确网址，不宣称完成了该产品的审查。

Grok 参考截图是官网中的公开示例，不是登录后的原生 App 验收。动效参考是页面可交互演示；静态截图只能记录某一帧。

## 本次改版前检查

1. `screenshots/brand-upgrade/01-chat-before.jpg`：桌面空白对话。主要操作存在，但品牌仅为蓝底 T，缺少开始交流的引导。
2. `screenshots/brand-upgrade/02-settings-before.jpg`：桌面设置。信息分组清楚，外观与普通表单接近，尚未形成自己的视觉语言。
3. `screenshots/brand-upgrade/03-mobile-before.jpg`：390px 手机设置。分类可读、触控目标充足；留白与层次可提升。已替换首次缩放异常的废弃捕获。
4. `screenshots/brand-upgrade/04-pairing-before.jpg`：配对页。安全步骤明确，缺少产品身份和主次构图。
5. `screenshots/brand-upgrade/05-conversation-before.jpg`：桌面带消息会话。浅蓝用户气泡已具辨识度，应保留；Bot 头像相同且界面层次较弱。

## 设计约束

- 品牌：温暖、专业、有伙伴感；避免照搬竞品人物或动效素材。
- 操作：新 Bot、新对话、新群、新话题各自含义清楚；现有入口、鉴权、头像、引用/转发和原生问题表单均保留。
- 动效：短暂入场与操作反馈；不重播每个 token，不改虚拟消息列表的定位 transform；尊重减少动态效果。
- 验收：真实 Hub/Gateway 的隔离演示，模拟引擎内容。浏览器结果不等同于 iOS/Android/Tauri 安装包验收。
