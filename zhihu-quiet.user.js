// ==UserScript==
// @name         知乎静阅
// @name:zh-CN   知乎静阅
// @namespace    dongx.zhihuquiet
// @version      2.0.4
// @description  知乎桌面阅读增强脚本：响应式居中、三种配色、正文关键词去跳转与悬浮收起。
// @author       dongx
// 原始脚本：知乎简化 1.36，作者 chengdu，MIT；个人修改 Copyright (c) 2026 dongx，AGPL-3.0-only。
// 第三方版权与许可说明：https://github.com/Zorabi/zhihu-quiet/blob/main/THIRD_PARTY_NOTICES.md
// @match        https://www.zhihu.com/*
// @match        https://zhuanlan.zhihu.com/*
// @icon         https://static.zhihu.com/heifetz/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @license      AGPL-3.0-only
// @homepageURL  https://github.com/Zorabi/zhihu-quiet
// @supportURL   https://github.com/Zorabi/zhihu-quiet/issues
// @downloadURL  https://raw.githubusercontent.com/Zorabi/zhihu-quiet/main/zhihu-quiet.user.js
// @updateURL    https://raw.githubusercontent.com/Zorabi/zhihu-quiet/main/zhihu-quiet.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 避免在无用的内嵌 iframe 内部重复执行并报错
    if (window.self !== window.top) return;

    // 默认配置项
    const DEFAULT_CONFIG = {
        readingTheme: 'graphite',     // 阅读配色；original 跟随知乎当前配色
        enabled: true,                // 启用静阅（一键停用/启用全局所有功能）
        cleanHeaderItems: true,       // 精简顶栏：隐藏「直答」、蓝色「+」提问按钮、「AI Works」及「故事」
        hidePublishCard: true,        // 隐藏首页创作发布卡片（发想法/提问题/写回答/写文章）
        blueCardDivider: true,        // 首页每个话题卡片之间增加蓝色线条间隔
        hideLowComments: false,       // 隐藏评论少于 10 条的话题内容（默认关闭）
        blockKanshan: true,           // 屏蔽看山 bot 与 AI 总结
        cleanSearch: true,            // 深度净化搜索：清空搜索框轮播推荐词，并移除下拉菜单中的热搜发现
        loadRawImage: true,           // 默认加载高清无水印原图：绕过知乎压缩低清图，自动加载高清无水印原图
        debug: false                  // 调试模式：开启后在控制台输出各模块的详细日志（选择器健康告警不受此项控制，始终输出）
    };

    // 固定的私人阅读布局，不作为用户偏好保存或提供开关。
    const PERSONAL_LAYOUT = Object.freeze({ avatarAtStart: true, hideSidebar: true });

    const CONFIG_KEY = 'zhihu_simplify_config';

    // 安全获取类名字符串（兼容 SVG 等非标准 className 对象）
    function getSafeClassName(el) {
        if (!el) return '';
        if (typeof el.className === 'string') return el.className.toLowerCase();
        if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal.toLowerCase();
        return '';
    }

    // 读取持久化配置
    function loadConfig() {
        try {
            const stored = GM_getValue(CONFIG_KEY, null);
            if (!stored) {
                // 历史版本的旧存储键，迁移完成后立即清理，避免永久残留
                const LEGACY_KEYS = [
                    'zhihu_beautifier_config_v17', 'zhihu_beautifier_config_v16',
                    'zhihu_beautifier_config_v15', 'zhihu_beautifier_config_v14',
                    'zhihu_beautifier_config_v13', 'zhihu_beautifier_config_v12',
                    'zhihu_beautifier_config_v11', 'zhihu_beautifier_config'
                ];
                let prev = null;
                LEGACY_KEYS.forEach(k => {
                    const v = GM_getValue(k, null);
                    if (v) {
                        if (!prev) prev = v;
                        try {
                            if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
                        } catch (e) {}
                    }
                });
                let initial = { ...DEFAULT_CONFIG };
                if (prev) {
                    try {
                        const parsed = typeof prev === 'string' ? JSON.parse(prev) : prev;
                        initial = Object.assign(initial, parsed);
                    } catch (e) {}
                }
                initial.hideLowComments = false;
                GM_setValue(CONFIG_KEY, JSON.stringify(initial));
                return initial;
            }
            const res = Object.assign({}, DEFAULT_CONFIG, typeof stored === 'string' ? JSON.parse(stored) : stored);
            // 清理历史 bug 写入的脏键（总开关 checkbox 曾向 config["null"] 写值）
            delete res['null'];
            delete res['undefined'];
            // 兼容向后迁移：如果旧存储里包含 blockSearchPlaceholder 或 blockSearchDiscovery，合并给 cleanSearch
            if (typeof res.cleanSearch === 'undefined') {
                if (typeof res.blockSearchPlaceholder !== 'undefined' || typeof res.blockSearchDiscovery !== 'undefined') {
                    res.cleanSearch = Boolean(res.blockSearchPlaceholder !== false && res.blockSearchDiscovery !== false);
                } else {
                    res.cleanSearch = true;
                }
            }
            if (typeof res.loadRawImage === 'undefined') {
                res.loadRawImage = true;
            }
            return res;
        } catch (e) {
            return { ...DEFAULT_CONFIG };
        }
    }

    function normalizeConfig(stored) {
        const cleaned = {};
        for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
            const value = stored?.[key];
            cleaned[key] = typeof value === typeof fallback ? value : fallback;
        }
        if (!['system', 'original', 'graphite'].includes(cleaned.readingTheme)) cleaned.readingTheme = 'graphite';
        return cleaned;
    }
    let config = normalizeConfig(loadConfig());
    try { GM_setValue(CONFIG_KEY, JSON.stringify(config)); } catch (e) {}

    // ============================================================
    // 网络层源头拦截：从根源掐断实时热搜与轮播推荐词请求
    // 目标接口: https://www.zhihu.com/api/v4/search/recommend_query/v2
    // ============================================================
    const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    function isRecommendQueryUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return url.includes('search/recommend_query');
    }

    // 1. Fetch 网络请求拦截
    if (targetWin.fetch) {
        const origFetch = targetWin.fetch;
        targetWin.fetch = async function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input?.url || '');
                if (config.enabled !== false && config.cleanSearch && isRecommendQueryUrl(url)) {
                    // 模拟返回空数据结构，让知乎前端 React 拿不到任何热搜，从源头杜绝轮播定时器与热搜节点生成
                    return new Response(JSON.stringify({ data: [], query: '', queries: [] }), {
                        status: 200,
                        statusText: 'OK',
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            } catch (e) {}
            return origFetch.apply(this, arguments);
        };
    }

    // 2. XMLHttpRequest 网络请求拦截
    if (targetWin.XMLHttpRequest) {
        const OrigXHR = targetWin.XMLHttpRequest;
        const origOpen = OrigXHR.prototype.open;
        const origSend = OrigXHR.prototype.send;
        const EMPTY_RECOMMEND_BODY = JSON.stringify({ data: [], query: '', queries: [] });

        OrigXHR.prototype.open = function (method, url) {
            this._zhUrl = typeof url === 'string' ? url : (url && typeof url.toString === 'function' ? url.toString() : '');
            return origOpen.apply(this, arguments);
        };

        OrigXHR.prototype.send = function (body) {
            if (config.enabled !== false && config.cleanSearch && isRecommendQueryUrl(this._zhUrl)) {
                const xhr = this;
                try {
                    // 使用 defineProperty 覆写只读属性；若浏览器拒绝则回落到真实请求
                    const define = (key, value) => Object.defineProperty(xhr, key, { value, writable: false, configurable: true });
                    define('status', 200);
                    define('statusText', 'OK');
                    define('readyState', 4);
                    define('responseURL', xhr._zhUrl || '');
                    define('responseText', EMPTY_RECOMMEND_BODY);
                    // response 需根据 responseType 返回正确类型，知乎前端通常用 json 或 text
                    const rt = xhr.responseType;
                    define('response', rt === 'json' ? JSON.parse(EMPTY_RECOMMEND_BODY) : EMPTY_RECOMMEND_BODY);
                    define('getAllResponseHeaders', () => 'content-type: application/json\r\n');
                    define('getResponseHeader', (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null));

                    // 异步派发，确保调用方在 send() 之后注册的监听器也能收到事件；补齐 loadend 以免 Promise 封装永久挂起
                    setTimeout(() => {
                        try {
                            xhr.dispatchEvent(new Event('readystatechange'));
                            xhr.dispatchEvent(new ProgressEvent('load'));
                            xhr.dispatchEvent(new ProgressEvent('loadend'));
                        } catch (e) {}
                    }, 0);
                    return;
                } catch (e) {}
            }
            return origSend.apply(this, arguments);
        };
    }

    // 保存配置
    function saveConfig(cfg) {
        try {
            GM_setValue(CONFIG_KEY, JSON.stringify(cfg));
            applyAllStyles();
            syncSidebarState();
            scanAndFilterDOM();
        } catch (e) {
            console.error('[知乎静阅] 保存配置异常:', e);
        }
    }

    // 初始提早同步侧边栏隐藏 class，在 DOM 尚未渲染完时即压制侧栏，防止闪烁
    // （该 class 由下方 generateCSS 中的 html.zh-hide-sidebar 规则消费）
    if (config.enabled !== false && PERSONAL_LAYOUT.hideSidebar && document.documentElement) {
        document.documentElement.classList.add('zh-hide-sidebar');
    }

    // 动态样式管理（优先使用 GM_addStyle 穿透 CSP 策略）
    let injectedStyleNode = null;
    const STYLE_ELEMENT_ID = 'zhihu-simplify-custom-style';

    // 独立于知乎自身的深色开关，颜色不依赖当前站点主题。
    const READING_THEMES = {
        system: { name: '跟随系统' },
        original: { name: '知乎默认' },
        graphite: { name: '石墨灰', dark: true, bg: '#202224', card: '#27292c', text: '#bfc3c8', muted: '#949ba4', accent: '#9baec4', line: '#35393e' },
    };

    const LIGHT_READING_THEME = {
        dark: false, bg: '#f6f6f6', card: '#ffffff', text: '#121212',
        muted: '#707a89', accent: '#175199', line: '#e5e9ee'
    };
    const systemColorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    function resolveReadingTheme() {
        if (config.readingTheme === 'system') {
            return systemColorScheme.matches ? READING_THEMES.graphite : LIGHT_READING_THEME;
        }
        return READING_THEMES[config.readingTheme];
    }

    function generateCSS() {
        if (config.enabled === false) {
            return '';
        }

        let css = `
        /* 通用精致过渡（只过渡视觉属性，绝不过渡 width/left/transform，避免吸底栏与布局重算时产生抖动） */
        .Topstory-container, .Question-main, .Search-container, .Post-NormalMain, .Post-Main {
            transition: background-color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }

        /* 专栏文章排版优雅协调：卡片化、圆角、上下呼吸边距与阴影 */
        .Post-NormalMain,
        .Post-Main,
        article.Post-NormalMain,
        article.Post-Main,
        article[class*="Post-"],
        [class*="Post-NormalMain"],
        [class*="Post-Main"],
        [class*="PostIndex-normal"] {
            border-radius: 8px !important;
            margin-top: 18px !important;
            margin-bottom: 28px !important;
            transition: background-color 0.2s ease, box-shadow 0.2s ease !important;
        }

        /* 专栏题图/封面图顶部圆角贴合，杜绝直角溢出破坏圆角 */
        .TitleImage,
        .Post-TitleImage,
        .Post-Header-titleImage,
        .Post-Header > img,
        img[class*="TitleImage"] {
            border-top-left-radius: 8px !important;
            border-top-right-radius: 8px !important;
            display: block !important;
        }

        /* 专栏内各层文字容器清理背景，避免遮挡卡片底色 */
        .Post-content,
        .Post-Header,
        .Post-Author,
        .AuthorInfo,
        .Post-RichTextContainer,
        .Post-RichText,
        .Post-topicsAndReviewer,
        .BottomBar-content {
            background: transparent !important;
        }
        `;

        // 2. 顶栏重排：去掉知乎 Logo，将头像移至最左侧
        if (PERSONAL_LAYOUT.avatarAtStart) {
            css += `
            /* 隐藏左侧知乎蓝色 Logo（严格限定为自身，绝不触碰直接父级容器） */
            .AppHeader-zhihuLogo,
            a[aria-label="知乎"],
            a:has(> svg[class*="ZhihuLogo"]),
            a:has(> svg.ZhihuLogo),
            svg.ZhihuLogo {
                display: none !important;
            }

            /* 移动至顶栏最左侧的用户头像容器（作为 Flex 第一项自然排布，紧贴最左侧） */
            .zh-moved-avatar,
            [data-zh-moved-avatar="true"] {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                order: -9999 !important;
                margin-right: 18px !important;
                margin-left: 0 !important;
                padding-left: 0 !important;
                flex-shrink: 0 !important;
                z-index: 100 !important;
                visibility: visible !important;
                opacity: 1 !important;
                pointer-events: auto !important;
                cursor: pointer !important;
            }

            .zh-moved-avatar *,
            [data-zh-moved-avatar="true"] * {
                pointer-events: auto !important;
            }

            .zh-moved-avatar img,
            [data-zh-moved-avatar="true"] img {
                width: 32px !important;
                height: 32px !important;
                min-width: 32px !important;
                min-height: 32px !important;
                border-radius: 50% !important;
                object-fit: cover !important;
                display: block !important;
                visibility: visible !important;
                opacity: 1 !important;
                transition: transform 0.2s ease, box-shadow 0.2s ease !important;
            }

            .zh-moved-avatar:hover img,
            [data-zh-moved-avatar="true"]:hover img {
                transform: scale(1.08) !important;
                box-shadow: 0 0 0 2px rgba(0, 132, 255, 0.45) !important;
            }
            `;
        }

        // 3. 精简顶栏多余入口（直答、+提问、AI Works、故事）与搜索框排版优化
        if (config.cleanHeaderItems) {
            css += `
            /* 隐藏顶栏导航项：AI Works、故事及各类分隔线（故事入口仅匹配独立路径，避免误伤含 story 追踪参数的普通链接） */
            .AppHeader a[href*="ai-works"],
            .AppHeader a[href*="ai_works"],
            .AppHeader a[href^="/story"],
            .AppHeader a[href^="https://www.zhihu.com/story"],
            .AppHeader-Tabs a[href*="ai-works"],
            .AppHeader-Tabs a[href^="/story"],
            .AppHeader-Tabs a[href^="https://www.zhihu.com/story"],
            .AppHeader [class*="divider"],
            .AppHeader [class*="Divider"],
            .Tabs [class*="divider"],
            .Tabs [class*="Divider"],
            /* 隐藏「直答」按钮 */
            .AppHeader a[href*="zhida.zhihu.com"],
            .AppHeader a[href*="zhida"],
            .AppHeader button:has([class*="zhida"]),
            .AppHeader [data-za-detail-view-element_name*="zhida"],
            /* 隐藏顶栏蓝色「+」提问/创作按钮（知乎当前 DOM：button.SearchBar-askDropdownButton，位于 .SearchBar-askContainer 内，aria-label 为「创作」） */
            .SearchBar-askContainer,
            .SearchBar-askDropdownButton,
            button[aria-label="创作"].Button--primary,
            .AppHeader button[aria-label="创作"],
            .AppHeader button.Button--primary:has(> svg.ZDI--PlusFill24),
            .AppHeader button.Button--primary:has(> svg[class*="PlusFill"]),
            .AppHeader-userInfo > button.Button--primary,
            .AppHeader-userInfo button[aria-label*="提问"],
            .AppHeader-userInfo button[title*="提问"],
            .AppHeader-question,
            .AppHeader-askButton,
            [data-za-detail-view-element_name*="AskButton"],
            [data-za-detail-view-element_name*="QuestionButton"],
            [data-zh-hidden-ask="true"] {
                display: none !important;
            }

            /* 强制顶栏内部容器使用 flex-start，彻底打破知乎原生的 space-between 间隙强制均分 */
            .AppHeader-inner {
                display: flex !important;
                justify-content: flex-start !important;
                align-items: center !important;
            }

            /* 导航栏自适应内容宽度，彻底禁止 flex-grow 撑开多余空白 */
            .AppHeader-Tabs,
            .Tabs.AppHeader-Tabs,
            nav.AppHeader-nav,
            .AppHeader-nav {
                flex: none !important;
                flex-grow: 0 !important;
                flex-shrink: 0 !important;
                width: auto !important;
                margin-left: 0 !important;
                margin-right: 0 !important;
            }

            /* 顶栏搜索框左移（紧跟导航栏“圈子”之后 24px，禁止推向右侧） */
            .AppHeader-SearchBar,
            .SearchBar,
            [class*="AppHeader-SearchBar"] {
                margin-left: 24px !important;
                margin-right: 0 !important;
                width: 380px !important;
                max-width: 440px !important;
                flex: none !important;
                flex-shrink: 0 !important;
                /* 只过渡视觉属性；width/margin 若参与过渡，知乎首屏重排时搜索框会可见地滑动 */
                transition: box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s ease !important;
            }

            .SearchBar-input,
            .SearchBar-inputWrapper {
                width: 100% !important;
                max-width: 100% !important;
            }

            /* 右侧操作按钮组靠最右侧，吃掉中间所有多余空间 */
            .AppHeader-userInfo,
            [class*="AppHeader-userInfo"] {
                margin-left: auto !important;
                margin-right: 0 !important;
                flex-shrink: 0 !important;
                display: flex !important;
                align-items: center !important;
                gap: 12px !important;
            }
            `;
        }

        // 5. 隐藏首页创作发布卡片（发想法 / 提问题 / 写回答 / 写文章）
        // 注意：不再整体隐藏 .TopstoryHeader（该容器可能承载「关注/推荐/热榜」Tab），改由 JS 精准标记 data-zh-publish-card
        if (config.hidePublishCard) {
            css += `
            /* 隐藏首页发想法与创作卡片 */
            .GlobalWrite,
            .GlobalWriteV2,
            [class*="GlobalWrite"],
            [data-zh-publish-card="true"] {
                display: none !important;
            }
            `;
        }

        // 卡片右上角快捷关闭按钮通用样式
        css += `
        .zh-card-close-btn {
            position: absolute !important;
            top: 10px !important;
            right: 12px !important;
            width: 22px !important;
            height: 22px !important;
            border-radius: 50% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            color: #8590a6 !important;
            background: rgba(0, 0, 0, 0.04) !important;
            transition: all 0.2s ease !important;
            z-index: 10 !important;
            border: none !important;
            outline: none !important;
            padding: 0 !important;
        }
        .zh-card-close-btn:hover {
            background: rgba(0, 0, 0, 0.1) !important;
            color: #121212 !important;
            transform: scale(1.1) !important;
        }
        .zh-card-close-btn svg {
            width: 13px !important;
            height: 13px !important;
            fill: currentColor !important;
        }
        `;

        // 6. 首页每个话题卡片之间的蓝色线条间隔
        if (config.blueCardDivider) {
            css += `
            /* 首页与个人主页每个话题/动态卡片之间的蓝色线条间隔与呼吸边距 */
            .TopstoryItem:not(:last-child),
            .Topstory-mainColumn > div > div > .TopstoryItem:not(:last-child),
            .Topstory-mainColumn > div > .TopstoryItem:not(:last-child),
            .ProfileMain .List-item:not(:last-child) {
                position: relative !important;
                border-bottom: 2px solid rgba(0, 132, 255, 0.3) !important;
                padding-bottom: 18px !important;
                margin-bottom: 14px !important;
                transition: border-color 0.25s ease, box-shadow 0.25s ease !important;
            }

            /* 鼠标悬停卡片时的淡蓝微光泽强化 */
            .TopstoryItem:not(:last-child):hover,
            .ProfileMain .List-item:not(:last-child):hover {
                border-bottom-color: rgba(0, 132, 255, 0.65) !important;
            }
            `;
        }

        // 7. 隐藏评论少于 10 条的话题卡片
        if (config.hideLowComments) {
            css += `
            /* 隐藏评论少于 10 条的低讨论话题 */
            .TopstoryItem[data-zh-low-comments="true"],
            [data-zh-low-comments="true"] {
                display: none !important;
            }
            `;
        }

        // 8. 问题页标题与头部区域严格左对齐下方回答卡片（蓝线对齐）
        // 仅在侧栏隐藏时启用：侧栏展开时原生右栏需要 QuestionHeader-side 的常规布局，绝对定位会与之冲突
        if (PERSONAL_LAYOUT.hideSidebar) {
            css += `
            /* 问题页头部容器版心对齐 */
            .QuestionHeader-content {
                position: relative !important;
                max-width: 1000px !important;
                width: 100% !important;
                margin: 0 auto !important;
                padding-left: 0 !important;
                box-sizing: border-box !important;
            }

            /* 问题头部主列：清零内边距，左侧边缘与下方回答卡片严格切齐 */
            .QuestionHeader-main {
                padding-left: 0 !important;
                margin-left: auto !important;
                margin-right: auto !important;
                width: 694px !important;
                max-width: 100% !important;
                float: none !important;
                box-sizing: border-box !important;
                transition: margin-left 0.2s ease, width 0.2s ease !important;
            }

            /* 内部标题、标签、按钮栏内边距强制归零，确保文字垂直切齐 */
            .QuestionHeader-tags,
            .QuestionHeader-title,
            .QuestionHeader-detail,
            .QuestionHeader-footer,
            .QuestionButtonGroup {
                padding-left: 0 !important;
                margin-left: 0 !important;
            }

            .QuestionHeader-title {
                text-align: left !important;
            }

            /* 右侧关注者/被浏览指标浮动于右上角，绝不抢占主列空间 */
            .QuestionHeader-side {
                position: absolute !important;
                right: 0 !important;
                top: 24px !important;
            }
            `;
        }

        // 9. 屏蔽「看山 bot」与各类 AI 摘要/问答模块
        if (config.blockKanshan) {
            css += `
            /* 看山 bot 及 AI 总结模块强力屏蔽 */
            .Question-aiSummary,
            .AiSummary,
            .AISummary,
            .KanshanRobot,
            [class*="Kanshan"],
            [class*="kanshan"],
            [class*="aiSummary"],
            [class*="AiSummary"],
            [class*="ai-summary"],
            [data-za-detail-view-path-module*="Kanshan"],
            [data-za-detail-view-path-module*="kanshan"],
            [data-za-detail-view-path-module*="AiSummary"],
            .AnswerItem[data-is-kanshan="true"],
            .TopstoryItem[data-is-kanshan="true"] {
                display: none !important;
            }
            `;
        }

        // 10. 深度净化搜索：清空搜索输入框推荐词 + 移除下拉菜单热搜发现
        if (config.cleanSearch) {
            css += `
            /* 搜索框 input placeholder 彻底透明与隐藏，杜绝热搜轮播闪烁 */
            .SearchBar input::placeholder,
            .SearchBar-input input::placeholder,
            .AppHeader-SearchBar input::placeholder,
            input[type="search"]::placeholder,
            input.Input::placeholder {
                color: transparent !important;
                opacity: 0 !important;
                text-shadow: none !important;
            }
            /* 针对知乎可能的悬浮文字层与占位标签 */
            .SearchBar-label,
            .SearchBar-placeholder,
            [class*="SearchBar-placeholder"],
            [class*="hotSearch-placeholder"] {
                display: none !important;
                opacity: 0 !important;
            }

            /* 搜索发现与热搜推荐条目屏蔽
               知乎原生分组类名（来自其 CSS，均有据）：
                 历史分组 .SearchBar-groupItem--hisotry（知乎自己拼错的 history，原样使用），条目 .SearchBar-historyItem，
                 标签栏 .SearchBar-historyLabel 或 .SearchBar-label--history（两者均存在于知乎 CSS），清空 .SearchBar-historyDeleteAll；
                 热搜分组 .SearchBar-groupItem--topSearch，条目 .SearchBar-topSearchItem。
               规则只命中热搜分组与条目，绝不按「带标题的分组」整体隐藏，否则历史会一起消失。
               下方 .HotSearch / .SearchBar-hotSearch / .AutoComplete-* 为原脚本遗留，本地证据中未找到，保留以兼容可能的旧版 DOM。 */
            .SearchBar-groupItem--topSearch,
            .SearchBar-topSearchItem,
            [class*="SearchBar-groupItem--topSearch"],
            [class*="SearchBar-topSearchItem"],
            .SearchBar-hotSearch,
            .HotSearch,
            [class*="hotSearch"],
            [class*="HotSearch"],
            [class*="SearchSuggest-hotSearch"],
            [class*="searchSuggest-hotSearch"],
            .SearchBar-menu div[data-type="hot_search"],
            [id^="AutoComplete"][id*="-topSearch-"],
            .AutoComplete-group:has(.SearchBar-hotSearch),
            .AutoComplete-group:has([class*="hotSearch"]),
            .AutoComplete-group:has([class*="HotSearch"]),
            .AutoComplete-item:has(svg[class*="FireFill"]),
            [data-zh-hidden-hot="true"] {
                display: none !important;
            }

            /* 历史分组显式保护：即使上方某条宽泛规则误命中，也强制恢复显示 */
            .SearchBar-historyItem,
            .SearchBar-historyLabel,
            .SearchBar-label--history,
            .SearchBar-historyDeleteAll,
            .SearchBar-historyLabelDeleteAll,
            [class*="SearchBar-historyItem"],
            [data-zh-search-history="true"] {
                display: flex !important;
            }
            .SearchBar-groupItem--hisotry,
            [class*="SearchBar-groupItem--hisotry"] {
                display: block !important;
            }
            `;
        }

        /* 商业推广卡片与通栏组件静默清除（内置底层保活，无条件生效） */
        css += `
        .TopstoryItem--advertCard,
        .Pc-card,
        .Banner-link,
        [data-za-detail-view-element_name*="Advert"],
        .Feed-advert,
        .Advert-container,
        .EcommerceQuestion-wrapper,
        .Question-sideColumnAds,
        .Banner-ad,
        .TopstoryItem[data-za-extra-module*="banner"],
        .TopstoryItem[data-za-extra-module*="advert"],
        div[class*="advertCard"],
        div[data-ad="true"],
        .pc-article-answer-big-img,
        [class*="pc-article-answer-big-img"],

        .Pc-Business-Card-PcTopFeedBanner,
        .Business-Card-PcTopFeedBanner-link,
        .Business-Card-PcTopFeedBanner-img,
        [class*="Pc-Business-Card"],
        [class*="Business-Card"],
        [class*="BusinessCard"],
        [class*="PcTopFeedBanner"],
        [class*="TopFeedBanner"],
        [class*="FeedBanner"],
        .AdvertImg,
        [class*="AdvertImg"],

        a[href*="sugar.zhihu.com"],
        a[href*="glory_adreaper"],
        a[href*="adreaper"],
        div:has(> a[href*="sugar.zhihu.com"]),
        div:has(> a[href*="glory_adreaper"]),
        .TopstoryItem:has(a[href*="sugar.zhihu.com"]),
        .TopstoryItem:has(a[href*="glory_adreaper"]),
        .Card:has(a[href*="sugar.zhihu.com"]),
        .Card:has(a[href*="glory_adreaper"]),
        [data-zh-blocked-ad="true"] {
            display: none !important;
        }
        `;

        // 13. 右侧边栏彻底隐藏与自适应居中（全方位选择器 + flex 抑制）
        // 规则同时绑定 html.zh-hide-sidebar，使 document-start 阶段提前添加的 class 真正生效，消除首屏闪烁
        if (PERSONAL_LAYOUT.hideSidebar) {
            css += `
            /* 强力隐藏侧栏（全域覆盖首页、问题页、个人/机构主页、搜索页、专栏文章页及语义化 aside） */
            html.zh-hide-sidebar .GlobalSideBar,
            html.zh-hide-sidebar .Question-sideColumn,
            html.zh-hide-sidebar .Topstory-sideColumn,
            .GlobalSideBar,
            .Question-sideColumn,
            .Topstory-sideColumn,
            .SearchSide-container,
            .Search-sideColumn,
            .SearchSideBar,
            .SearchSide,
            .Profile-sideColumn,
            [class*="GlobalSideBar"],
            [class*="sideColumn"],
            [class*="SideColumn"],
            [class*="Topstory-side"],
            [class*="SearchSide"],
            [class*="searchSide"],
            [class*="Search-side"],
            [class*="search-side"],
            [class*="SearchSideColumn"],
            [class*="SearchSideBar"],
            [class*="searchSideBar"],
            [class*="SearchSections-side"],
            [class*="SearchSections-sidebar"],
            [class*="Profile-sideColumn"],
            /* 专栏页面侧边栏与推荐栏强力收起 */
            .Post-Side,
            .Post-NormalSub,
            .Post-Sub,
            .PostIndex-side,
            [class*="Post-Side"],
            [class*="Post-NormalSub"],
            [class*="Post-Sub"],
            [class*="PostIndex-side"],
            div[role="complementary"],
            aside,
            .Topstory-container > div:nth-child(2),
            .Question-main > div:nth-child(2),
            .Profile-main > div:nth-child(2),
            [data-zh-search-sidebar="true"] {
                display: none !important;
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                flex: 0 0 0 !important;
                opacity: 0 !important;
                pointer-events: none !important;
                visibility: hidden !important;
            }

            /* 主内容在容器内水平居中（首页、问题页、个人/机构主页、专栏文章） */
            .Topstory-container,
            .Question-main,
            .Profile-main,
            .ProfileContainer,
            [class*="Profile-main"],
            [class*="ProfileContainer"],
            .Post-Row,
            .PostIndex-root,
            [class*="Post-Row"],
            /* 专栏页真实布局：.Post-content > [哈希 flex 行] > [哈希主列 > article.Post-Main] + [哈希侧栏壳]；
               哈希类名不可依赖，用 :has() 以 article 为锚点定位 flex 行 */
            .Post-content > div:has(article.Post-Main),
            .Post-content > div:has(article.Post-NormalMain) {
                display: flex !important;
                justify-content: center !important;
            }

            /* 专栏页右侧栏壳：定宽 296px 且 flex-shrink:0 的哈希 div，内含 role=complementary 的「关于作者」卡片。
               仅隐藏内部卡片不够，必须隐藏整个壳，否则它仍在 flex 行中占位导致正文偏左 */
            .Post-content > div:has(article.Post-Main) > div:has(> [role="complementary"]),
            .Post-content > div:has(article.Post-Main) > div:has(> div > [role="complementary"]),
            .Post-content > div:has(article.Post-Main) > div:has(> a[aria-label="边栏锚点"]),
            .Post-content > div:has(article.Post-Main) > div:has(.AuthorCard),
            [data-zh-post-sidebar="true"] {
                display: none !important;
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                flex: 0 0 0 !important;
            }

            /* 专栏页主列壳（article 的直接父级链）：清除可能的 flex-grow/定宽限制，让 justify-content:center 生效 */
            .Post-content > div:has(article.Post-Main) > div:has(article.Post-Main) {
                margin-left: auto !important;
                margin-right: auto !important;
                flex-grow: 0 !important;
                flex-shrink: 0 !important;
            }

            .Topstory-mainColumn,
            .Question-mainColumn,
            .Profile-mainColumn,
            [class*="Profile-mainColumn"],
            .Post-NormalMain,
            .Post-Main,
            article.Post-NormalMain,
            article.Post-Main,
            article[class*="Post-"],
            [class*="Post-NormalMain"],
            [class*="Post-Main"] {
                margin-left: auto !important;
                margin-right: auto !important;
                float: none !important;
            }

            /* 搜索页主列安全居中（不强加定宽与 flex，防断层） */
            .SearchMain {
                margin-left: auto !important;
                margin-right: auto !important;
                float: none !important;
            }

            /* 修复长回答/专栏吸底操作栏在居中沉浸模式下的定位偏右与截断断层
               原因与对策：
               1) 知乎 JS 实时写入内联 left/width，若脚本再用 left:50% + transform 居中，两套定位会打架；
               2) 知乎原生 .RichContent-actions.is-fixed 带 slideInUp 动画，关键帧改的就是 transform，
                  脚本若强制 transform:translateX(-50%) 会与动画互相覆盖，表现为入场时左右跳动；
               3) 因此改用 left:0 + right:0 + margin:0 auto 居中，完全不碰 transform；
               4) 宽度跟随正文列宽而非硬编码 694px，避免与知乎写入的 width 不一致时反复重排。 */
            .ContentItem-actions.is-fixed,
            .RichContent-actions.is-fixed,
            [class*="ContentItem-actions"][class*="is-fixed"],
            [class*="ContentItem-actions"][class*="fixed"] {
                position: fixed !important;
                bottom: 0 !important;
                left: 0 !important;
                right: 0 !important;
                margin-left: auto !important;
                margin-right: auto !important;
                width: var(--zh-main-col-width, 694px) !important;
                max-width: 100vw !important;
                box-sizing: border-box !important;
                z-index: 99 !important;
                /* 禁止对定位类属性做过渡，杜绝知乎重算 left/width 时的滑动感 */
                transition: background-color 0.2s ease, box-shadow 0.2s ease !important;
            }

            /* 专栏吸底操作栏居中对齐 */
            .BottomBar,
            [class*="BottomBar"] {
                display: flex !important;
                justify-content: center !important;
                left: 0 !important;
                right: 0 !important;
                width: 100% !important;
                box-sizing: border-box !important;
            }
            .BottomBar-content,
            .Post-actions,
            [class*="BottomBar-content"],
            [class*="Post-actions"] {
                margin: 0 auto !important;
                width: var(--zh-main-col-width, 694px) !important;
                max-width: 100% !important;
            }
            `;
        }


        /* 响应式版心：解除站点桌面最小宽度，不通过裁剪隐藏溢出。 */
        css += `
        html, body, .App, .App-main {
            min-width: 0 !important;
        }
        .AppHeader-inner {
            box-sizing: border-box !important;
            width: 100% !important;
            min-width: 0 !important;
            max-width: 1048px !important;
            margin-inline: auto !important;
            padding-inline: clamp(12px, 2vw, 24px) !important;
            flex-wrap: nowrap !important;
            height: auto !important;
        }
        .AppHeader-Tabs {
            min-width: 0 !important;
            max-width: 100% !important;
            overflow-x: auto;
        }
        .AppHeader .SearchBar {
            min-width: 0 !important;
            max-width: 100% !important;
            flex-shrink: 1 !important;
        }
        .Topstory-container, .Question-main, .Search-container,
        .Profile-main, .ProfileHeader, .Post-content, .Post-Row {
            box-sizing: border-box !important;
            min-width: 0 !important;
            max-width: 100% !important;
        }
        .Topstory-mainColumn, .Question-mainColumn, .SearchMain,
        .Profile-mainColumn, .Post-Main, .Post-NormalMain {
            min-width: 0 !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
        }
        /* 展开状态不再沿用摘要的高度、行数或渐隐裁切；折叠状态维持原行为。 */
        .RichContent:not(.is-collapsed) .RichContent-inner,
        .RichContent:not(.is-collapsed) .RichContent-inner .RichText {
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            -webkit-line-clamp: unset !important;
            line-clamp: unset !important;
            mask-image: none !important;
            -webkit-mask-image: none !important;
        }
        /* 正文实体词只取消跳转，文字、位置和排版保留。 */
        .RichText a[data-zh-entity-text="true"] {
            color: inherit !important;
            text-decoration: none !important;
            pointer-events: none !important;
            cursor: text !important;
        }
        .RichText a[data-zh-entity-text="true"] svg[class*="FourPointedStar"] {
            display: none !important;
        }
        /* 回答详情页使用哈希外壳，以实际回答列标记祖先，避免依赖生成类名。 */
        html.zh-question-layout .AppHeader .PageHeader:has(.QuestionHeader-content) { display: none !important; }
        html.zh-question-layout .MoreAnswers > .List > .List-header { display: none !important; }
        html.zh-question-layout .AppHeader [data-zh-header-layout],
        html.zh-question-layout .AppHeader [data-zh-header-leaf] {
            opacity: 1 !important;
            visibility: visible !important;
            transform: none !important;
        }
        html.zh-question-layout .QuestionPage {
            min-width: 0 !important; max-width: 100% !important;
            width: 100% !important; box-sizing: border-box !important;
        }
        html.zh-question-layout .QuestionPage :is(div, section, article, form, ul, ol, li, p, blockquote) {
            min-width: 0 !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
        }
        html.zh-question-layout [data-zh-question-shell] {
            display: block !important;
            flex: 1 1 auto !important;
            width: 100% !important; min-width: 0 !important; max-width: 100% !important;
            padding-inline: 0 !important; margin-inline: auto !important;
            box-sizing: border-box !important;
        }
        html.zh-question-layout .QuestionPage [data-zh-question-shell="outer"] {
            width: calc(100% - clamp(16px, 4vw, 48px)) !important;
            max-width: 1000px !important;
        }
        html.zh-question-layout,
        html.zh-question-layout body {
            max-width: 100% !important;
            overflow-x: clip !important;
        }
        html.zh-question-layout .App-main,
        html.zh-question-layout .App-main > div {
            width: 100% !important; min-width: 0 !important; max-width: 100% !important;
            margin-inline: 0 !important; box-sizing: border-box !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader .QuestionHeader-content,
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner {
            width: calc(100% - clamp(16px, 4vw, 48px)) !important;
            max-width: 1000px !important;
            margin-inline: auto !important;
            padding-inline: 0 !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-main {
            min-width: 0 !important; max-width: 100% !important; flex-shrink: 1 !important;
        }
        html.zh-question-layout .QuestionPage :is(p, li, blockquote, .RichText, .CommentItem-content) {
            overflow-wrap: anywhere;
        }
        html.zh-question-layout .QuestionPage :is(pre, .RichText table) {
            max-width: 100% !important;
            overflow-x: auto;
        }
        /* 问题头部采用纵向信息流，统计不再绝对定位覆盖标题。 */
        html.zh-question-layout .QuestionPage .QuestionHeader > .QuestionHeader-content {
            display: flex !important; flex-direction: column !important;
            align-items: stretch !important; gap: 10px !important;
            padding-block: 16px 12px !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-side {
            position: static !important; inset: auto !important;
            width: auto !important; flex: 0 0 auto !important;
            margin: 0 !important; padding: 0 !important;
            align-self: flex-start !important;
        }
        html.zh-question-layout .QuestionPage .QuestionFollowStatus-counts {
            display: flex !important; align-items: center !important; gap: 18px !important;
            margin: 0 !important; padding: 0 !important; border: 0 !important;
        }
        html.zh-question-layout .QuestionPage .QuestionFollowStatus-counts .NumberBoard-item {
            display: inline-flex !important; flex: 0 0 auto !important;
            width: auto !important; min-height: 0 !important;
            margin: 0 !important; padding: 0 !important; border: 0 !important;
        }
        html.zh-question-layout .QuestionPage .NumberBoard-itemInner {
            display: flex !important; align-items: baseline !important; gap: 6px !important;
        }
        html.zh-question-layout .QuestionPage .NumberBoard-itemName,
        html.zh-question-layout .QuestionPage .NumberBoard-itemValue {
            font-size: 12px !important; line-height: 20px !important; font-weight: 400 !important;
        }
        html.zh-question-layout .QuestionPage .QuestionFollowStatus-counts .NumberBoard-item::after,
        html.zh-question-layout .QuestionPage .QuestionFollowStatus-counts .NumberBoard-item::before { display: none !important; }
        html.zh-question-layout .QuestionPage .QuestionHeader-topics {
            display: flex !important; flex-wrap: wrap !important; gap: 6px !important;
        }
        html.zh-question-layout .QuestionPage .QuestionTopic {
            margin: 0 !important; padding: 3px 8px !important;
            font-size: 12px !important; line-height: 20px !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-title {
            margin-block: 10px 6px !important;
            font-size: clamp(20px, 2.5vw, 24px) !important;
            line-height: 1.4 !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-detail {
            margin-top: 6px !important; font-size: 14px !important; line-height: 1.7 !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner {
            display: flex !important; align-items: center !important; justify-content: flex-start !important;
            flex-wrap: wrap !important; gap: 6px !important; padding-block: 8px !important;
        }
        html.zh-question-layout .QuestionPage :is(.QuestionHeader-footer-main, .QuestionButtonGroup, .QuestionHeaderActions, .QuestionHeader-actions) {
            display: contents !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner :is(.GoodQuestionAction, .QuestionHeader-Comment, .ShareMenu-toggler) {
            display: inline-flex !important; align-items: center !important;
            flex: 0 0 auto !important; margin: 0 !important; width: auto !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button {
            display: inline-flex !important; align-items: center !important; justify-content: center !important;
            flex: 0 0 auto !important; gap: 4px !important;
            width: auto !important; min-width: 0 !important; max-width: none !important;
            height: 32px !important; margin: 0 !important; padding: 0 9px !important;
            font-size: 13px !important; line-height: 20px !important;
            white-space: nowrap !important; border: 0 !important; border-radius: 6px !important;
            box-sizing: border-box !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button span {
            flex-shrink: 0 !important; line-height: 0;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button svg {
            width: 16px !important; height: 16px !important;
        }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button:focus { outline: none; box-shadow: none; }
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button:focus-visible,
        html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button:hover {
            background: var(--zh-reading-line, #edf1f5) !important;
        }
        html.zh-question-layout .Question-mainColumn,
        html.zh-question-layout .QuestionAnswer-content,
        html.zh-question-layout .AnswerCard,
        html.zh-question-layout .Question-mainColumn .RichContent,
        html.zh-question-layout .Question-mainColumn .RichContent-inner,
        html.zh-question-layout .Question-mainColumn .RichText {
            min-width: 0 !important; max-width: 100% !important;
            box-sizing: border-box !important;
        }
        html.zh-question-layout .Question-mainColumn .RichText {
            white-space: normal !important;
            overflow-wrap: anywhere;
        }
        .RichText { overflow-wrap: anywhere; }
        .RichText img, .RichText video { max-width: 100%; height: auto; }
        .RichText pre { max-width: 100%; overflow-x: auto; }
        `;
        if (PERSONAL_LAYOUT.hideSidebar) {
            css += `
            .Topstory-container, .Question-main, .Search-container,
            .Profile-main, .QuestionHeader-content {
                width: calc(100% - clamp(16px, 4vw, 48px)) !important;
                max-width: 1000px !important;
                min-width: 0 !important;
                margin-inline: auto !important;
                padding-inline: 0 !important;
                box-sizing: border-box !important;
                column-gap: 0 !important;
            }
            .Topstory-mainColumn, .Question-mainColumn, .SearchMain,
            .Profile-mainColumn {
                flex: 0 1 100% !important;
                width: 100% !important;
                max-width: 100% !important;
                margin-inline: auto !important;
                float: none !important;
            }
            .QuestionHeader-main {
                width: 100% !important;
                max-width: 100% !important;
                margin-inline: auto !important;
                transition: background-color 0.2s ease !important;
            }
            .Post-content > div:has(article.Post-Main),
            .Post-content > div:has(article.Post-NormalMain),
            .Post-content > div > div:has(> article.Post-Main),
            .Post-content > div > div:has(> article.Post-NormalMain) {
                min-width: 0 !important;
                max-width: 100% !important;
                flex-shrink: 1 !important;
                box-sizing: border-box !important;
            }
            .Post-Main, .Post-NormalMain {
                width: min(100%, 1000px) !important;
                margin-inline: auto !important;
            }
            .ContentItem-actions.is-fixed, .RichContent-actions.is-fixed {
                max-width: calc(100% - clamp(16px, 4vw, 48px)) !important;
            }
            `;
        }

        const theme = resolveReadingTheme();
        if (theme && theme.bg) {
            css += `
            :root {
                color-scheme: ${theme.dark ? 'dark' : 'light'};
                --zh-reading-bg: ${theme.bg};
                --zh-reading-card: ${theme.card};
                --zh-reading-text: ${theme.text};
                --zh-reading-muted: ${theme.muted};
                --zh-reading-accent: ${theme.accent};
                --zh-reading-line: ${theme.line};
            }
            html body, html .App, html .App-main {
                background-color: var(--zh-reading-bg) !important;
                color: var(--zh-reading-text) !important;
            }
            html .Topstory-container, html .Question-main, html .Search-container,
            html .Profile-main, html .Post-content, html .Post-Row {
                background: transparent !important;
            }
            html .Card, html .TopstoryItem, html .AppHeader,
            html .QuestionHeader, html .QuestionHeader-content,
            html .ProfileHeader, html .Post-Main, html .Post-NormalMain,
            html .ContentItem-actions, html .RichContent-actions,
            html .BottomBar, html .Comments-container {
                background: var(--zh-reading-card) !important;
                color: var(--zh-reading-text) !important;
                border-color: var(--zh-reading-line) !important;
                box-shadow: none !important;
            }
            html .ContentItem-title, html .ContentItem-title a,
            html .RichText, html .RichContent, html .QuestionHeader-title,
            html .Post-Title, html .AuthorInfo-name, html .AuthorInfo-name a,
            html .AppHeader-Tab {
                color: var(--zh-reading-text) !important;
            }
            /* 展开后新增的正文节点也继承阅读色，避免站点深色文字落在暗色背景上。 */
            html .RichText :is(p, span, strong, b, em, i, u, s, del, ins, font,
                h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd,
                blockquote, pre, code, table, thead, tbody, tr, th, td, figcaption):not([style*="transparent"]) {
                color: inherit !important;
            }
            html .ContentItem-meta, html .ContentItem-actions .Button,
            html .RichContent-actions .Button, html .RichContent-inner .ContentItem-arrowIcon {
                color: var(--zh-reading-muted) !important;
            }
            html .RichText a, html .ContentItem-more, html .Button--link,
            html .AppHeader-Tab.is-active { color: var(--zh-reading-accent) !important; }
            html .VoteButton, html .VoteButton.is-active {
                background: var(--zh-reading-line) !important;
                color: var(--zh-reading-accent) !important;
            }
            html .TopstoryItem, html .TopstoryItem .Card {
                border-bottom-color: var(--zh-reading-line) !important;
            }
            /* 评论区独立渲染，正文主题不会自动覆盖其内容、排序与编辑器。 */
            html :is(.Comments-container, .CommentsV2) {
                background: var(--zh-reading-card) !important;
                color: var(--zh-reading-text) !important;
                border-color: var(--zh-reading-line) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(div, section, span, button, input, textarea) {
                border-color: var(--zh-reading-line) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(.CommentContent, .CommentItem-content, [data-zh-comment-heading]),
            html :is(.Comments-container, .CommentsV2) a[href*="/people/"] {
                color: var(--zh-reading-text) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(.CommentContent, .CommentItem-content) :is(span, p, strong, b, em, i) {
                color: inherit !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(.CommentContent, .CommentItem-content) a {
                color: var(--zh-reading-accent) !important;
            }
            html [data-zh-comment-meta] { color: var(--zh-reading-muted) !important; }
            html :is(.Comments-container, .CommentsV2) button {
                color: var(--zh-reading-muted) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(div, section) { box-shadow: none !important; }
            html :is(.Comments-container, .CommentsV2) button.Button--grey {
                background: var(--zh-reading-bg) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(button.Button--blue, button.is-active, button[aria-pressed="true"]) {
                color: var(--zh-reading-accent) !important;
            }
            html :is(.Comments-container, .CommentsV2) button.Button--primary {
                background: var(--zh-reading-line) !important;
                color: var(--zh-reading-text) !important;
            }
            html [data-zh-comment-floating-surface] {
                background: transparent !important;
                border: 0 !important;
                box-shadow: none !important;
            }
            html #zh-reading-collapse,
            html [data-zh-comment-floating="true"] {
                background: var(--zh-reading-line) !important;
                color: var(--zh-reading-text) !important;
                border: 0 !important;
                box-shadow: none !important;
            }
            html #zh-reading-collapse:hover,
            html [data-zh-comment-floating="true"]:hover {
                background: var(--zh-reading-bg) !important;
            }
            html [data-zh-comment-sort] {
                background: var(--zh-reading-bg) !important;
                border-color: var(--zh-reading-line) !important;
            }
            html [data-zh-comment-sort-option] {
                background: transparent !important;
                color: var(--zh-reading-muted) !important;
            }
            html [data-zh-comment-sort-option="selected"] {
                background: var(--zh-reading-line) !important;
                color: var(--zh-reading-text) !important;
            }
            html [data-zh-comment-editor-surface] {
                background: var(--zh-reading-card) !important;
                border-color: var(--zh-reading-line) !important;
                box-shadow: none !important;
            }
            html [data-zh-comment-editor-surface]::before,
            html [data-zh-comment-editor-surface]::after {
                background: none !important;
                box-shadow: none !important;
                border-color: var(--zh-reading-line) !important;
            }
            html :is(.Comments-container, .CommentsV2) :is(.InputLike, .Input-wrapper, textarea, .Editable-content, .public-DraftEditor-content) {
                background: var(--zh-reading-bg) !important;
                color: var(--zh-reading-text) !important;
                border-color: var(--zh-reading-line) !important;
                caret-color: var(--zh-reading-text) !important;
            }
            html :is(.Comments-container, .CommentsV2) .public-DraftEditor-content * { color: inherit !important; }
            html :is(.Comments-container, .CommentsV2) :is(.public-DraftEditorPlaceholder-inner, .public-DraftEditorPlaceholder-root) {
                color: var(--zh-reading-muted) !important;
            }
            /* 加载占位与已加载卡片使用相同主题，覆盖站点仍处于暗色的骨架。 */
            html [data-zh-loading-surface="true"],
            html .Topstory-mainColumn :is(.Skeleton, .SkeletonLoading, .LoadingSkeleton, .Placeholder) {
                background: var(--zh-reading-card) !important;
                border-color: var(--zh-reading-line) !important;
            }
            html [data-zh-loading-bar="true"],
            html .Topstory-mainColumn :is(.Skeleton-row, .Skeleton-line, .Placeholder-row) {
                background: var(--zh-reading-line) !important;
                box-shadow: none !important;
                filter: none !important;
                animation: zh-quiet-loading-pulse 1.8s ease-in-out infinite !important;
            }
            /* 深色扫光可能位于伪元素或子层，单改底色无法覆盖它。 */
            html :is([data-zh-loading-bar="true"], .Topstory-mainColumn .Skeleton-row, .Topstory-mainColumn .Skeleton-line, .Topstory-mainColumn .Placeholder-row)::before,
            html :is([data-zh-loading-bar="true"], .Topstory-mainColumn .Skeleton-row, .Topstory-mainColumn .Skeleton-line, .Topstory-mainColumn .Placeholder-row)::after {
                content: none !important;
                display: none !important;
                background: none !important;
                box-shadow: none !important;
                animation: none !important;
            }
            html [data-zh-loading-bar="true"] > * {
                visibility: hidden !important;
            }
            @keyframes zh-quiet-loading-pulse {
                0%, 100% { opacity: .65; }
                50% { opacity: .95; }
            }
            @media (prefers-reduced-motion: reduce) {
                html [data-zh-loading-bar="true"],
                html .Topstory-mainColumn :is(.Skeleton-row, .Skeleton-line, .Placeholder-row) {
                    animation: none !important;
                }
            }
            /* 外层只负责布局，避免浅色卡片之外残留另一层白底或阴影。 */
            html .Topstory-mainColumn,
            html .Topstory-mainColumnCard,
            html .Topstory-content,
            html .Topstory-recommend {
                background: transparent !important;
                box-shadow: none !important;
                border: 0 !important;
            }
            html .TopstoryItem, html .TopstoryItem > .Card {
                border-left: 0 !important;
                border-right: 0 !important;
                box-shadow: none !important;
            }
            html .ContentItem-actions.is-fixed,
            html .RichContent-actions.is-fixed {
                background: var(--zh-reading-card) !important;
                border-left: 0 !important;
                border-right: 0 !important;
                box-shadow: none !important;
            }
            html.zh-question-layout .QuestionPage .QuestionTopic {
                background: var(--zh-reading-line) !important;
                color: var(--zh-reading-muted) !important;
            }
            html.zh-question-layout .QuestionPage .QuestionTopic a { color: inherit !important; }
            html.zh-question-layout .QuestionPage .NumberBoard-itemName,
            html.zh-question-layout .QuestionPage .NumberBoard-itemValue,
            html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner button,
            html .AppHeader .SearchBar-searchButton,
            html .AppHeader [data-zh-header-action] {
                color: var(--zh-reading-muted) !important;
            }
            html .RichText blockquote, html .RichText pre,
            html .Input-wrapper, html .SearchBar-input {
                background: var(--zh-reading-bg) !important;
                color: var(--zh-reading-text) !important;
                border-color: var(--zh-reading-line) !important;
            }
            `;
        }

        css += `
        #zh-simplify-panel {
            color-scheme: light !important;
            color: #333 !important;
        }
        #zh-simplify-panel .zh-theme-buttons { display: flex; gap: 8px; margin-top: 10px; }
        #zh-simplify-panel .zh-theme-button {
            flex: 1; padding: 8px 12px; border: 0; border-radius: 6px;
            background: #f1f3f5; color: #555; font: inherit; cursor: pointer;
        }
        #zh-simplify-panel .zh-theme-button[aria-pressed="true"] { background: #e5efff; color: #1763bf; }
        #zh-simplify-panel .zh-theme-button:hover { background: #e4e8ed; }
        #zh-simplify-panel .zh-theme-button:focus { outline: none; box-shadow: none; }
        #zh-simplify-panel .zh-theme-button:focus-visible { background: #d4e3f5; }
        #zh-simplify-panel .zh-theme-button:active { opacity: .75; }
        /* 原生收起按钮优先占位，其余操作单行滚动。 */
        html .ContentItem-actions, html .RichContent-actions {
            display: flex !important;
            flex-wrap: nowrap !important;
            min-width: 0 !important;
            box-sizing: border-box !important;
            height: auto !important;
            row-gap: 8px;
        }
        html .ContentItem-actions .ContentItem-rightButton,
        html .RichContent-actions .ContentItem-rightButton,
        html .ContentItem-actions .RichContent-collapsedText,
        html .RichContent-actions .RichContent-collapsedText {
            order: -1 !important;
            flex: 0 0 auto !important;
            margin-left: 0 !important;
            margin-right: 12px !important;
            position: static !important;
            white-space: nowrap !important;
        }
        /* 基于实际顶栏结构，包装层仅保留 DOM，不再重复贡献间距。 */
        html body .AppHeader [data-zh-header-layout]:not([data-zh-header-host]):not([data-zh-header-leaf]),
        html body .AppHeader [data-zh-header-tool-path] { display: contents !important; }
        html body .AppHeader { min-width: 0 !important; padding-inline: 0 !important; }
        html body .AppHeader [data-zh-header-host] {
            --zh-header-gap: clamp(8px, 1.2vw, 14px);
            display: flex !important; flex-flow: row nowrap !important;
            align-items: center !important; justify-content: flex-start !important;
            gap: var(--zh-header-gap) !important;
            width: 100% !important; min-width: 0 !important; max-width: 100% !important;
            height: 52px !important; min-height: 52px !important;
            margin: 0 !important; padding: 0 clamp(10px, 1.5vw, 20px) !important;
            box-sizing: border-box !important;
            flex: 1 1 auto !important;
        }
        html body .AppHeader [data-zh-header-leaf="nav"] {
            display: flex !important; flex: 0 1 auto !important;
            align-items: center !important; justify-content: flex-start !important;
            gap: var(--zh-header-gap) !important;
            width: auto !important; min-width: 0 !important;
            margin: 0 !important; padding: 0 !important;
            overflow-x: auto !important; overflow-y: hidden !important;
            white-space: nowrap !important; scrollbar-width: thin;
        }
        html body .AppHeader [data-zh-header-leaf="nav"] > a {
            flex: 0 0 auto !important; display: flex !important;
            width: auto !important; min-width: 0 !important;
            margin: 0 !important; padding: 0 !important;
            font-size: 15px !important; line-height: 48px !important;
        }
        html body .AppHeader [data-zh-header-leaf="nav"] > a > div {
            display: flex !important; align-items: center !important;
            width: auto !important; min-width: 0 !important; max-width: none !important;
            margin: 0 !important; padding: 0 !important;
        }
        html body .AppHeader [data-zh-header-leaf="nav"] > div:empty { display: none !important; }
        html body .AppHeader [data-zh-header-leaf="search"] {
            display: flex !important; align-items: center !important;
            flex: 1 0 112px !important;
            width: 0 !important;
            min-width: 112px !important; max-width: clamp(180px, 32vw, 420px) !important;
            margin: 0 !important; padding: 0 !important;
        }
        html body .AppHeader .SearchBar-tool,
        html body .AppHeader .SearchBar-tool > div,
        html body .AppHeader .SearchBar-tool .Popover,
        html body .AppHeader .SearchBar-input {
            width: 100% !important; min-width: 0 !important; max-width: 100% !important;
            margin: 0 !important; box-sizing: border-box !important;
        }
        html body .AppHeader .SearchBar-input {
            display: flex !important; align-items: center !important;
            height: 32px !important; min-height: 32px !important;
            padding: 0 8px !important; border-radius: 7px !important;
        }
        html body .AppHeader .SearchBar input {
            flex: 1 1 auto !important; width: 0 !important; min-width: 0 !important;
        }
        html body .AppHeader .SearchBar-searchButton {
            position: static !important; transform: none !important;
            flex: 0 0 24px !important; width: 24px !important; height: 28px !important;
            padding: 0 !important; margin: 0 !important;
            background: transparent !important; border: 0 !important;
        }
        html body .AppHeader .zh-moved-avatar,
        html body .AppHeader [data-zh-moved-avatar="true"] {
            display: flex !important; align-items: center !important;
            position: relative !important; inset: auto !important; transform: none !important;
            flex: 0 0 32px !important; width: 32px !important; height: 32px !important;
            margin: 0 !important; padding: 0 !important;
        }
        html body .AppHeader .AppHeader-profileEntry {
            display: flex !important; align-items: center !important; justify-content: center !important;
            width: 32px !important; height: 32px !important; margin: 0 !important; padding: 0 !important;
        }
        html body .AppHeader [data-zh-header-action] {
            display: inline-flex !important; position: relative !important;
            align-self: center !important; align-items: center !important; justify-content: center !important;
            flex: 0 0 28px !important; width: 28px !important; height: 32px !important;
            margin: 0 !important; padding: 0 !important; border: 0 !important;
            inset: auto !important; transform: none !important;
            min-width: 28px !important; max-width: 28px !important;
            box-sizing: border-box !important;
            background: transparent !important; overflow: visible !important;
        }
        html body .AppHeader [data-zh-header-action],
        html body .AppHeader [data-zh-header-action] * { font-size: 0 !important; }
        html body .AppHeader [data-zh-header-action] div:not([data-zh-header-badge]) {
            position: static !important; transform: none !important;
            margin: 0 !important; padding: 0 !important;
        }
        html body .AppHeader [data-zh-header-action] svg {
            position: absolute !important; top: 50% !important; left: 50% !important;
            width: 18px !important; height: 18px !important; margin: 0 !important;
            transform: translate(-50%, -50%) !important;
        }
        html body .AppHeader [data-zh-header-action] [data-zh-header-badge] {
            position: absolute !important; top: -1px !important; right: -2px !important;
            left: auto !important; bottom: auto !important; transform: none !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            min-width: 12px !important; width: auto !important; height: 12px !important;
            margin: 0 !important; padding: 0 2px !important; border-radius: 6px !important;
            font-size: 9px !important; line-height: 12px !important;
        }
        html body .AppHeader [data-zh-header-spacer="true"] { display: none !important; }
        /* 多余空间放在搜索框与消息组之间，两端使用同一份容器内边距。 */
        html body .AppHeader [data-zh-header-action]:has(svg[class*="Bell"]) {
            margin-left: auto !important;
        }
        /* 最右图标的可见边缘对齐头像外缘，不再叠加按钮内部的半格留白。 */
        html body .AppHeader [data-zh-header-action]:has(svg[class*="ChatBubbleTwo"]) > div > svg {
            left: auto !important;
            right: 0 !important;
            transform: translateY(-50%) !important;
        }
        html body .AppHeader [data-zh-header-action]:focus { outline: none; box-shadow: none; }
        html body .AppHeader [data-zh-header-action]:focus-visible {
            background: var(--zh-reading-line, #edf1f5) !important;
        }
        html .ContentItem-actions, html .RichContent-actions {
            overflow-x: auto !important; white-space: nowrap !important;
        }
        html .ContentItem-actions > *, html .RichContent-actions > * { flex-shrink: 0 !important; }
        /* 站点操作栏的负边距会超出卡片，在两侧形成阶梯状色块。 */
        html .ContentItem-actions:not(.is-fixed):not(.ContentItem-action),
        html .RichContent-actions:not(.is-fixed):not(.ContentItem-action) {
            margin-inline: 0 !important;
            padding-inline: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
        }
        html .ContentItem-actions:not(.ContentItem-action)::before,
        html .ContentItem-actions:not(.ContentItem-action)::after,
        html .RichContent-actions::before,
        html .RichContent-actions::after {
            display: none !important;
        }

        #zh-reading-collapse {
            position: fixed;
            right: max(var(--zh-collapse-right, 12px), env(safe-area-inset-right));
            bottom: max(76px, calc(env(safe-area-inset-bottom) + 60px));
            z-index: 99990;
            max-width: min(calc(100vw - 24px), var(--zh-collapse-max-width, 100vw));
            padding: 9px 14px;
            border: 0;
            border-radius: 6px;
            background: var(--zh-reading-card, #e8edf3);
            color: var(--zh-reading-text, #364152);
            font: 14px/1.5 system-ui, sans-serif;
            cursor: pointer;
            box-shadow: none;
        }
        html body #zh-reading-collapse,
        html body [data-zh-comment-floating="true"] {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 6px !important;
            box-sizing: border-box !important;
            height: 32px !important;
            min-height: 32px !important;
            line-height: 20px !important;
            white-space: nowrap !important;
        }
        html body [data-zh-comment-floating="true"] > span {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 16px !important;
            width: 16px !important;
            height: 16px !important;
            margin: 0 !important;
            padding: 0 !important;
            line-height: 0 !important;
        }
        html body [data-zh-comment-floating="true"] svg {
            position: static !important;
            display: block !important;
            flex: 0 0 16px !important;
            width: 16px !important;
            height: 16px !important;
            margin: 0 !important;
            transform: none !important;
        }
        html body #zh-reading-collapse[hidden] { display: none !important; }
        html [data-zh-comment-proxy-host="true"] { display: none !important; }
        #zh-reading-collapse:hover, #zh-reading-collapse:focus-visible {
            background: var(--zh-reading-line, #d5dfeb);
        }
        #zh-reading-collapse:focus { outline: none; box-shadow: none; }
        #zh-reading-collapse:active { opacity: .75; }
        `;

        if (theme?.dark) {
            css += `
            html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner :is(.FollowButton, .WriteAnswerButton) {
                background: #34383d !important; color: #bdc4ce !important;
            }
            html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner .FollowButton[aria-pressed="true"],
            html.zh-question-layout .QuestionPage .QuestionHeader-footer-inner .FollowButton.is-followed {
                background: #40454c !important; color: #d0d5db !important;
            }

            html body #zh-reading-collapse,
            html body [data-zh-comment-floating="true"] {
                background: #34383d !important;
                color: #b9c0c8 !important;
                border: 0 !important;
                border-radius: 7px !important;
                font-size: 13px !important;
                font-weight: 400 !important;
                line-height: 1.5 !important;
                padding: 6px 10px !important;
                box-shadow: none !important;
            }
            html body [data-zh-comment-floating="true"] svg {
                color: inherit !important;
            }
            html body #zh-reading-collapse:hover,
            html body [data-zh-comment-floating="true"]:hover,
            html body #zh-reading-collapse:focus-visible,
            html body [data-zh-comment-floating="true"]:focus-visible {
                background: #41464d !important;
                color: #d0d5db !important;
                outline: none !important;
                box-shadow: none !important;
            }
            html body #zh-reading-collapse:active,
            html body [data-zh-comment-floating="true"]:active {
                background: #2e3237 !important;
            }
            `;
        }

        return css;
    }

    function updateDockTheme() {
        const dock = document.getElementById('zh-side-dock');
        if (!dock) return;
        let palette = config.enabled !== false ? resolveReadingTheme() : null;
        if (!palette?.bg) {
            // 知乎默认模式不向页面写入配色，只读取当前可见背景用于工具条。
            let background = null;
            for (const element of document.querySelectorAll('.AppHeader, .Card, body')) {
                if (!element.getClientRects().length) continue;
                const color = getComputedStyle(element).backgroundColor;
                if (!/^rgba?\(/.test(color)) continue;
                const channels = color.match(/[\d.]+/g)?.map(Number);
                if (!channels || channels.length < 3 || channels[3] === 0) continue;
                background = { color, channels };
                // 优先使用顶栏或内容卡片，body 仅作为回退。
                if (element !== document.body) break;
            }
            const dark = background ? background.channels.slice(0, 3).reduce((a, b) => a + b, 0) / 3 < 128 : systemColorScheme.matches;
            palette = {
                card: background?.color || (dark ? '#27292c' : '#edf0f3'),
                muted: dark ? '#949ba4' : '#727b86',
                line: dark ? '#35393e' : '#dfe5eb'
            };
        }
        for (const [name, value] of Object.entries({
            '--zh-tool-bg': palette.card, '--zh-tool-fg': palette.muted, '--zh-tool-hover': palette.line
        })) {
            if (dock.style.getPropertyValue(name) !== value) dock.style.setProperty(name, value);
        }
    }

    function applyAllStyles() {
        const css = generateCSS();
        try {
            if (typeof GM_addStyle === 'function') {
                if (!injectedStyleNode) {
                    injectedStyleNode = GM_addStyle(css);
                } else {
                    injectedStyleNode.textContent = css;
                }
                updateDockTheme();
                return;
            }
        } catch (e) {}

        try {
            let el = document.getElementById(STYLE_ELEMENT_ID);
            if (!el) {
                el = document.createElement('style');
                el.id = STYLE_ELEMENT_ID;
                (document.head || document.documentElement).appendChild(el);
            }
            el.textContent = css;
        } catch (e) {}
        updateDockTheme();
    }

    // 初始尽早注入样式；仅在跟随系统模式下响应系统外观变化。
    applyAllStyles();
    systemColorScheme.addEventListener('change', () => {
        if (config.readingTheme === 'system') applyAllStyles();
        else updateDockTheme();
    });

    // 总开关停用时仍完整恢复网站原生布局。
    function syncSidebarState() {
        document.documentElement.classList.toggle('zh-hide-sidebar', config.enabled !== false);
    }

    // 侧边栏所有已知选择器清单（全域覆盖首页、问题页、个人/机构主页、专栏及搜索结果页）
    const SIDEBAR_SELECTORS = [
        '.GlobalSideBar',
        '.Question-sideColumn',
        '.Topstory-sideColumn',
        '.SearchSide-container',
        '.Search-sideColumn',
        '.SearchSideBar',
        '.SearchSide',
        '.Profile-sideColumn',
        '[class*="GlobalSideBar"]',
        '[class*="sideColumn"]',
        '[class*="SideColumn"]',
        '[class*="Topstory-side"]',
        '[class*="SearchSide"]',
        '[class*="searchSide"]',
        '[class*="Search-side"]',
        '[class*="search-side"]',
        '[class*="SearchSideColumn"]',
        '[class*="SearchSideBar"]',
        '[class*="searchSideBar"]',
        '[class*="SearchSections-side"]',
        '[class*="SearchSections-sidebar"]',
        '[class*="Profile-sideColumn"]',
        'div[role="complementary"]',
        'aside'
    ];

    // 还原顶栏头像：撤销 scanAndFilterDOM 中的物理移动、标记类与内联样式
    // 记录原始位置（父节点 + 后继兄弟）以便精确放回；若原位置已不存在则退回到 userInfo 区末尾
    function restoreHeaderAvatar() {
        try {
            document.querySelectorAll('.zh-moved-avatar, [data-zh-moved-avatar="true"]').forEach(el => {
                const origParent = el.__zhOrigParent;
                const origNext = el.__zhOrigNext;
                if (origParent && origParent.isConnected) {
                    if (origNext && origNext.parentElement === origParent) {
                        origParent.insertBefore(el, origNext);
                    } else {
                        origParent.appendChild(el);
                    }
                } else {
                    const userInfo = document.querySelector('.AppHeader-userInfo, [class*="AppHeader-userInfo"]');
                    if (userInfo && !userInfo.contains(el)) userInfo.appendChild(el);
                }
                el.classList.remove('zh-moved-avatar');
                el.removeAttribute('data-zh-moved-avatar');
                ['display', 'visibility', 'opacity', 'order'].forEach(p => el.style.removeProperty(p));
                delete el.__zhOrigParent;
                delete el.__zhOrigNext;
            });
        } catch (e) {}
    }

    // 还原「精简顶栏」模块写入的内联样式与标记（供关闭该开关或总开关时调用）
    function restoreHeaderItems() {
        try {
            const header = document.querySelector('.AppHeader, header');
            if (!header) return;
            // 1. 被本模块以 display:none 隐藏的链接/按钮/列表项/分隔条
            header.querySelectorAll('a, button, li, span, i, em, div, nav, [class*="SearchBar"]').forEach(el => {
                // 跳过脚本自身 UI 与已被头像模块接管的节点（其 display 由 restoreHeaderAvatar 负责）
                if (el.id && el.id.startsWith('zh-')) return;
                if (el.classList.contains('zh-moved-avatar') || el.hasAttribute('data-zh-moved-avatar')) return;
                if (el.style.display === 'none') el.style.removeProperty('display');
                ['flex', 'flex-grow', 'width', 'margin-left', 'margin-right', 'justify-content'].forEach(p => el.style.removeProperty(p));
            });
            // 2. 清除「+」按钮标记
            header.querySelectorAll('[data-zh-hidden-ask="true"]').forEach(el => {
                el.style.removeProperty('display');
                el.removeAttribute('data-zh-hidden-ask');
            });
            // 3. 顶栏内层容器 flex 排版
            const headerInner = header.querySelector('.AppHeader-inner') || header;
            if (headerInner) {
                headerInner.style.removeProperty('display');
                headerInner.style.removeProperty('justify-content');
            }
        } catch (e) {}
    }

    // 还原专栏文章页布局：清除 flex 行、主列壳、侧栏壳上由脚本写入的内联样式与标记
    // （供侧栏展开分支与总开关关闭路径共用）
    function restorePostLayout() {
        try {
            document.querySelectorAll('[data-zh-post-row="true"]').forEach(el => {
                ['display', 'justify-content'].forEach(p => el.style.removeProperty(p));
                el.removeAttribute('data-zh-post-row');
            });
            document.querySelectorAll('[data-zh-post-main="true"]').forEach(el => {
                ['margin-left', 'margin-right', 'flex-grow'].forEach(p => el.style.removeProperty(p));
                el.removeAttribute('data-zh-post-main');
            });
            document.querySelectorAll('[data-zh-post-sidebar="true"]').forEach(el => {
                ['display', 'width'].forEach(p => el.style.removeProperty(p));
                el.removeAttribute('data-zh-post-sidebar');
            });
            document.documentElement.style.removeProperty('--zh-main-col-width');
        } catch (e) {}
    }

    // 当总开关关闭时，全面还原知乎原生 DOM 状态
    function restoreNativeDOM() {
        try {
            // 0. 还原顶栏头像位置
            restoreHeaderAvatar();

            // 0.1 还原精简顶栏模块的隐藏与排版
            restoreHeaderItems();

            // 0.2 还原专栏文章页布局
            restorePostLayout();

            // 1. 恢复侧边栏显示与主列原生排版
            document.querySelectorAll(SIDEBAR_SELECTORS.join(',')).forEach(el => {
                if (el.id !== 'zh-sidebar-toggle-handle' && el.id !== 'zh-beautifier-panel') {
                    el.style.display = '';
                    el.style.width = '';
                }
            });
            document.querySelectorAll('[data-zh-search-sidebar="true"]').forEach(el => {
                el.style.display = '';
                el.style.width = '';
                el.removeAttribute('data-zh-search-sidebar');
            });
            document.querySelectorAll('.Topstory-container, .Question-main, .Profile-main, [class*="Profile-main"]').forEach(container => {
                Array.from(container.children).forEach(c => {
                    if (!c.id?.startsWith('zh-') && c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT') {
                        c.style.display = '';
                    }
                });
            });
            document.querySelectorAll('.Topstory-mainColumn, .Question-mainColumn, .SearchMain, .Profile-mainColumn, [class*="SearchMain"]').forEach(col => {
                col.style.marginLeft = '';
                col.style.marginRight = '';
                col.style.float = '';
                col.style.width = '';
            });
            document.querySelectorAll('.Topstory-container, .Question-main, .Profile-main, .Search-container, .SearchSections').forEach(cnt => {
                cnt.style.display = '';
                cnt.style.justifyContent = '';
            });

            // 2. 顶栏各元素的还原已统一由上方 restoreHeaderItems() 处理（避免重复遍历并误清头像节点的 !important 样式）

            // 3. 恢复发想法卡片
            document.querySelectorAll('[data-zh-publish-card="true"]').forEach(el => {
                el.style.display = '';
            });

            // 4. 恢复低评论与看山卡片
            document.querySelectorAll('[data-is-kanshan="true"], [data-zh-blocked-ad="true"], [data-zh-low-comments="true"], [data-zh-hidden-hot="true"]').forEach(el => {
                el.style.display = '';
            });

            // 4.1 恢复搜索净化的隐藏与标记（热搜条目、历史保护标记）
            restoreSearchClean();

            // 5. 恢复图片原始引用
            restoreNormalImages();

            // 6. 恢复问题页头部对齐的内联样式
            restoreQuestionHeaderLayout();
        } catch (e) {}
    }

    // 还原问题页头部的内联对齐样式（scanAndFilterDOM 第 5 步写入）
    function restoreQuestionHeaderLayout() {
        try {
            const qContent = document.querySelector('.QuestionHeader-content');
            const qMain = document.querySelector('.QuestionHeader-main');
            const qSide = document.querySelector('.QuestionHeader-side');
            if (qContent) ['position', 'padding-left'].forEach(p => qContent.style.removeProperty(p));
            if (qMain) ['padding-left', 'box-sizing', 'margin-left', 'margin-right', 'width'].forEach(p => qMain.style.removeProperty(p));
            if (qSide) ['position', 'right', 'top'].forEach(p => qSide.style.removeProperty(p));
            document.documentElement.style.removeProperty('--zh-main-col-width');
        } catch (e) {}
    }

    // DOM 扫描过滤（带全域安全异常保护，避免单个节点报错中断脚本）
    // ============================================================
    // 页面类型判定：每次扫描只计算一次，供各模块按页守卫，避免全站无差别扫描
    // ============================================================
    function getPageInfo() {
        const pathname = (window.location && window.location.pathname) || '';
        const hostname = (window.location && window.location.hostname) || '';
        return {
            pathname: pathname,
            hostname: hostname,
            isFollowPage: pathname === '/follow' || pathname.startsWith('/follow/'),
            isHomePage: pathname === '/' || pathname.startsWith('/follow') || pathname.startsWith('/hot'),
            isQuestionPage: pathname.startsWith('/question/'),
            isSearchPage: pathname.startsWith('/search'),
            isPostPage: /(^|\.)zhuanlan\.zhihu\.com$/.test(hostname) && pathname.startsWith('/p/')
        };
    }

    // ============================================================
    // 选择器集中表：JS 侧所有查询锚点集中于此，知乎改版时只需改这里一处。
    // （CSS 侧选择器在 generateCSS 内，改动时两边需保持同步。）
    // ============================================================
    const SELECTORS = {
        // 顶栏
        header: '.AppHeader, header',
        headerInner: '.AppHeader-inner',
        headerNav: 'nav.AppHeader-nav, .AppHeader-nav, .AppHeader-Tabs',   // [有据] .AppHeader-Tabs；[无据] .AppHeader-nav（原脚本遗留）
        profileEntry: '.AppHeader-profile, .AppHeader-profileEntry, [class*="AppHeader-profile"]',
        userInfo: '.AppHeader-userInfo, [class*="AppHeader-userInfo"]',
        searchBar: '.AppHeader-SearchBar, .SearchBar, [class*="AppHeader-SearchBar"]',
        askContainer: '.SearchBar-askContainer',
        askButton: '.SearchBar-askDropdownButton',
        searchButton: '.SearchBar-searchButton',
        movedAvatar: '.zh-moved-avatar, [data-zh-moved-avatar="true"]',
        // 首页
        homeMainCol: '.Topstory-mainColumn',
        publishCardCandidates: ':scope > .Card, :scope > div > .Card, :scope > div:not(.TopstoryItem), [class*="GlobalWrite"]',
        topstoryItem: '.TopstoryItem, .Card.TopstoryItem',
        mainLists: '.Topstory-mainColumn, .Topstory-mainColumn > div, .Topstory-container',
        // 问题页
        questionContent: '.QuestionPage .QuestionHeader-content',
        questionMain: '.QuestionPage .QuestionHeader-main',
        questionSide: '.QuestionPage .QuestionHeader-side',
        answerCol: '.Question-mainColumn, .Question-main, .QuestionAnswer-content',
        answerItem: '.AnswerItem:not([data-is-kanshan])',
        // 通用主列容器
        mainContainers: '.Topstory-container, .Question-main, .Profile-main, [class*="Profile-main"]',
        profileMainCol: '.Profile-mainColumn, [class*="Profile-mainColumn"]',
        profileMain: '.Profile-main, [class*="Profile-main"]',
        // 专栏页
        postArticle: 'article.Post-Main, article.Post-NormalMain',
        postContent: '.Post-content',
        // 搜索
        // 证据等级说明：标「[有据]」的类名来自知乎原生 CSS 或真实页面快照；标「[无据]」的为原脚本遗留、本地证据中未找到，知乎改版排查时优先怀疑。
        searchInput: '.SearchBar input, .SearchBar-input input, .AppHeader-SearchBar input, input[type="search"], input.Input',   // [有据] .SearchBar .SearchBar-input .Input；[无据] .AppHeader-SearchBar
        searchMenu: '.SearchBar-menu, .AutoComplete-menu, [class*="SearchBar-menu"], [class*="SearchSuggest"], [role="listbox"]', // [有据] .SearchBar-menu；[无据] .AutoComplete-menu [class*="SearchSuggest"]
        // 知乎原生分组类名 [有据]：历史分组拼写为 hisotry，这是知乎自己的拼写错误，原样使用，不做「修正」猜测
        searchHistoryGroup: '.SearchBar-groupItem--hisotry, [class*="SearchBar-groupItem--hisotry"]',
        searchHistoryItem: '.SearchBar-historyItem, [class*="SearchBar-historyItem"]',
        // 历史标签栏：知乎 CSS 同时定义了 .SearchBar-historyLabel 与 .SearchBar-label--history，两者均 [有据]，真实 DOM 用哪个未知，一并保护
        searchHistoryLabel: '.SearchBar-historyLabel, .SearchBar-label--history, .SearchBar-historyDeleteAll, .SearchBar-historyLabelDeleteAll',
        searchTopGroup: '.SearchBar-groupItem--topSearch, [class*="SearchBar-groupItem--topSearch"]',
        searchTopItem: '.SearchBar-topSearchItem, [class*="SearchBar-topSearchItem"], [id^="AutoComplete"][id*="-topSearch-"]',
        searchMainCol: '.SearchMain, [class*="SearchMain"]',
        searchResultSelector: '[data-za-detail-view-path-module*="SearchResult"], .SearchResult, .ContentItem, [class*="SearchResult"], [class*="ContentItem"]',
        // 广告
        adLinks: 'a[href*="sugar.zhihu.com"], a[href*="glory_adreaper"], a[href*="adreaper"]',
        adContainers: '.Pc-Business-Card-PcTopFeedBanner, [class*="PcTopFeedBanner"], [class*="Business-Card-PcTopFeedBanner"]',
        // 原图加载
        rawImages: 'img[data-original], img[data-actualsrc], img.origin_image, img.zh-lightbox-thumb, .RichText img, .RichContent img, .Post-RichText img, .SearchResult img, .ContentItem img, figure img, .TitleImage, .Post-TitleImage, img[class*="TitleImage"]'
    };

    // ============================================================
    // 统一日志：zhLog 默认静默（config.debug 为 true 时输出）；
    // zhWarn 始终输出，仅用于选择器健康检查这类需要用户可见的告警。
    // ============================================================
    function zhLog(scope, detail) {
        if (!config || config.debug !== true) return;
        try { console.log(`[知乎静阅][${scope}]`, detail); } catch (e) {}
    }
    function zhWarn(scope, detail) {
        try { console.warn(`[知乎静阅][${scope}]`, detail); } catch (e) {}
    }

    // ============================================================
    // 选择器健康检查：知乎改版导致关键锚点失配时给出控制台告警。
    // 在页面稳定后（延迟 4 秒）只运行一次，每个选择器最多报告一次。
    // ============================================================
    function collectHealthIssues(page) {
        const issues = [];
        const check = (name, sel) => {
            let hit = false;
            try { hit = document.querySelector(sel) !== null; } catch (e) { hit = false; }
            if (!hit) issues.push({ name: name, selector: sel });
        };
        check('顶栏容器', SELECTORS.header);
        if (page.isHomePage) check('首页主列', SELECTORS.homeMainCol);
        if (page.isQuestionPage) {
            check('问题页头部容器', SELECTORS.questionContent);
            check('问题页回答列', SELECTORS.answerCol);
        }
        if (page.isPostPage) check('专栏正文', SELECTORS.postArticle);
        if (page.isSearchPage) check('搜索主列', SELECTORS.searchMainCol);
        return issues;
    }

    let healthCheckScheduled = false;
    const healthReported = new Set();
    function scheduleHealthCheck() {
        if (healthCheckScheduled) return;
        healthCheckScheduled = true;
        setTimeout(() => {
            try {
                if (config.enabled === false) return;
                collectHealthIssues(getPageInfo()).forEach(issue => {
                    if (healthReported.has(issue.selector)) return;
                    healthReported.add(issue.selector);
                    zhWarn('选择器健康检查', `${issue.name} 未命中选择器「${issue.selector}」，知乎可能已改版，对应功能将失效`);
                });
            } catch (e) {}
        }, 4000);
    }

    // ============================================================
    // 扫描分发器：按页面类型只调用相关模块，避免全站无差别扫描。
    // 各模块的守卫条件与拆分前保持完全一致。
    // ============================================================
    const entityLinkAttributes = new WeakMap();
    function scanEntityWordLinks() {
        if (config.enabled === false) {
            document.querySelectorAll('a[data-zh-entity-text="true"]').forEach(link => {
                const saved = entityLinkAttributes.get(link);
                if (saved) {
                    for (const [name, value] of Object.entries(saved)) {
                        if (value === null) link.removeAttribute(name);
                        else link.setAttribute(name, value);
                    }
                    entityLinkAttributes.delete(link);
                }
                link.removeAttribute('data-zh-entity-text');
            });
            return;
        }
        document.querySelectorAll('.RichText a.RichContent-EntityWord[href*="zhida.zhihu.com"], .RichText a[data-zh-entity-text="true"]').forEach(link => {
            if (!entityLinkAttributes.has(link)) {
                entityLinkAttributes.set(link, {
                    href: link.getAttribute('href'),
                    target: link.getAttribute('target'),
                    tabindex: link.getAttribute('tabindex')
                });
            }
            link.removeAttribute('href');
            link.removeAttribute('target');
            link.removeAttribute('tabindex');
            if (link.getAttribute('data-zh-entity-text') !== 'true') link.setAttribute('data-zh-entity-text', 'true');
        });
    }

    const commentSortState = new WeakMap();
    function scanCommentsTheme() {
        if (config.enabled === false || !resolveReadingTheme()?.bg) return;
        document.querySelectorAll('.Comments-container, .CommentsV2').forEach(root => {
            root.querySelectorAll('.CommentContent, .CommentItem-content').forEach(content => {
                const meta = content.nextElementSibling;
                if (meta && !meta.hasAttribute('data-zh-comment-meta')) meta.setAttribute('data-zh-comment-meta', 'true');
            });
            root.querySelectorAll('div, span, button').forEach(element => {
                if (element.closest('.CommentContent, .CommentItem-content, .Editable')) return;
                if (element.children.length === 0 && /^\d+\s*条评论$/.test(element.textContent.trim())) {
                    if (!element.hasAttribute('data-zh-comment-heading')) element.setAttribute('data-zh-comment-heading', 'true');
                }
                const options = Array.from(element.children);
                if (options.length !== 2 || !options.every(option => /^(默认|最新)$/.test(option.textContent.trim()))) return;
                const signature = options.map(option => ['class', 'style', 'aria-selected', 'aria-pressed'].map(name => option.getAttribute(name) || '').join('|')).join(';');
                if (commentSortState.get(element) === signature && options.every(option => option.hasAttribute('data-zh-comment-sort-option'))) return;
                // 暂时去掉我们自己的色值，读取站点的选中态；不写入站点 class 或处理点击事件。
                element.removeAttribute('data-zh-comment-sort');
                options.forEach(option => option.removeAttribute('data-zh-comment-sort-option'));
                const rgb = color => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
                const background = rgb(getComputedStyle(element).backgroundColor);
                let selected = 0;
                let bestContrast = -1;
                options.forEach((option, index) => {
                    const explicit = option.getAttribute('aria-selected') === 'true' || option.getAttribute('aria-pressed') === 'true';
                    const color = rgb(getComputedStyle(option).color);
                    const contrast = explicit ? Infinity : color.reduce((sum, value, channel) => sum + Math.abs(value - (background[channel] || 0)), 0);
                    if (contrast > bestContrast) { bestContrast = contrast; selected = index; }
                });
                element.setAttribute('data-zh-comment-sort', 'true');
                options.forEach((option, index) => option.setAttribute('data-zh-comment-sort-option', index === selected ? 'selected' : 'normal'));
                commentSortState.set(element, signature);
            });
            root.querySelectorAll('[contenteditable="true"], textarea').forEach(editor => {
                for (let element = editor.parentElement; element && element !== root; element = element.parentElement) {
                    if (element.querySelector('.CommentContent, .CommentItem-content')) break;
                    if (!element.hasAttribute('data-zh-comment-editor-surface')) element.setAttribute('data-zh-comment-editor-surface', 'true');
                }
            });
        });
    }

    function scanLoadingPlaceholders() {
        // 知乎新版骨架可能只有哈希类名：只识别无正文、无交互控件的重复圆角短条。
        const contentSelector = 'a, button, input, textarea, img, video, canvas, [role="img"]';
        document.querySelectorAll('[data-zh-loading-surface], [data-zh-loading-bar]').forEach(element => {
            if (element.textContent.trim() || element.querySelector(contentSelector)) {
                element.removeAttribute('data-zh-loading-surface');
                element.removeAttribute('data-zh-loading-bar');
            }
        });
        if (config.enabled === false || !resolveReadingTheme()?.bg) return;
        document.querySelectorAll('.Topstory-mainColumn, .Question-mainColumn').forEach(scope => {
            scope.querySelectorAll('div, section').forEach(element => {
                if (element.children.length < 3 || element.textContent.trim() || element.querySelector(contentSelector)) return;
                const bars = Array.from(element.children).filter(child => {
                    const rect = child.getBoundingClientRect();
                    if (rect.height < 4 || rect.height > 32 || rect.width < 24) return false;
                    const style = getComputedStyle(child);
                    return parseFloat(style.borderRadius) >= 4 && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
                });
                if (bars.length < 3) return;
                for (const bar of bars) {
                    if (bar.getAttribute('data-zh-loading-bar') !== 'true') bar.setAttribute('data-zh-loading-bar', 'true');
                }
                for (let surface = element; surface && surface !== scope; surface = surface.parentElement) {
                    if (surface.textContent.trim() || surface.querySelector(contentSelector)) break;
                    if (surface.getAttribute('data-zh-loading-surface') !== 'true') surface.setAttribute('data-zh-loading-surface', 'true');
                }
            });
        });
    }

    function syncMainColumnWidth() {
        const columns = document.querySelectorAll('.Question-mainColumn, .Topstory-mainColumn, .SearchMain, .Profile-mainColumn, article.Post-Main, article.Post-NormalMain');
        for (const column of columns) {
            const width = Math.round(column.getBoundingClientRect().width);
            if (width <= 0 || !column.getClientRects().length) continue;
            const value = `${width}px`;
            if (document.documentElement.style.getPropertyValue('--zh-main-col-width') !== value) {
                document.documentElement.style.setProperty('--zh-main-col-width', value);
            }
            break;
        }
    }

    function scanAndFilterDOM() {
        try {
            scanEntityWordLinks();
            scanQuestionLayout();
            // 总开关关闭时短路并安全恢复原生界面
            if (config.enabled === false) {
                restoreNativeDOM();
                return;
            }

            const page = getPageInfo();

            scanHeaderAvatar();                                  // 1. 顶栏头像置左
            scanHeaderItems();                                   // 2. 精简顶栏入口
            scanResponsiveHeader();                              // 真实顶栏祖先链自适应
            if (page.isHomePage) scanHomePublishCard();          // 3. 首页创作发布卡片
            scanLowComments(page);                               // 4. 低评论话题过滤（关注页自动跳过）
            if (page.isQuestionPage) scanQuestionHeader();       // 5. 问题页头部对齐
            scanSidebar(page);                                   // 6. 侧边栏显隐与居中
            scanSearchClean();                                   // 8. 搜索净化
            scanKanshan(page);                                   // 10. 看山 bot
            scanAds();                                          // 11. 推广卡片
            scanMainListsRecovery();                            // 11b. 列表容器保活
            scanRawImages();                                    // 12. 高清原图
            syncMainColumnWidth();
            scanLoadingPlaceholders();
            scanCommentsTheme();
        } catch (err) {
            console.error('[知乎静阅] 扫描执行异常:', err);
        }
    }

    function scanQuestionLayout() {
        const enabled = config.enabled !== false && PERSONAL_LAYOUT.hideSidebar && getPageInfo().isQuestionPage;
        document.documentElement.classList.toggle('zh-question-layout', enabled);
        if (enabled && window.scrollX !== 0) {
            window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
        }
        if (!enabled) {
            document.querySelectorAll('[data-zh-question-shell]').forEach(el => el.removeAttribute('data-zh-question-shell'));
            return;
        }
        document.querySelectorAll('.QuestionPage .Question-mainColumn').forEach(column => {
            const page = column.closest('.QuestionPage');
            const shells = [];
            for (let el = column.parentElement; el && el !== page; el = el.parentElement) {
                shells.push(el);
            }
            shells.forEach((el, index) => {
                const role = index === shells.length - 1 ? 'outer' : 'inner';
                if (el.getAttribute('data-zh-question-shell') !== role) el.setAttribute('data-zh-question-shell', role);
            });
        });
    }

    // 新版知乎可能用哈希类名包装顶栏，按实际导航和搜索节点找到布局行。
    function scanResponsiveHeader() {
        const header = document.querySelector(SELECTORS.header);
        if (!header) return;
        const nav = header.querySelector(SELECTORS.headerNav) || header.querySelector('nav, [role="tablist"]');
        const search = header.querySelector(SELECTORS.searchBar) || header.querySelector('input[type="search"]')?.closest('form');
        if (!nav || !search || nav.contains(search) || search.contains(nav)) return;
        let row = nav.parentElement;
        while (row && row !== header && !row.contains(search)) row = row.parentElement;
        if (!row || !row.contains(search)) return;
        // 清除前端路由切换后遗留的标记，不移动 React 管理的节点。
        header.querySelectorAll('[data-zh-header-layout]').forEach(el => el.removeAttribute('data-zh-header-layout'));
        row.setAttribute('data-zh-header-layout', 'row');
        for (const [node, role] of [[nav, 'nav'], [search, 'search']]) {
            for (let el = node; el && el !== row; el = el.parentElement) {
                el.setAttribute('data-zh-header-layout', role);
            }
        }
        for (let el = row.parentElement; el && el !== header; el = el.parentElement) {
            el.setAttribute('data-zh-header-layout', 'outer');
        }
        header.querySelectorAll('[data-zh-header-host], [data-zh-header-leaf]').forEach(el => {
            el.removeAttribute('data-zh-header-host');
            el.removeAttribute('data-zh-header-leaf');
        });
        const avatar = header.querySelector(SELECTORS.movedAvatar);
        let host = row;
        while (avatar && !host.contains(avatar) && host !== header) host = host.parentElement;
        host.setAttribute('data-zh-header-host', 'true');
        for (const layout of [host, ...host.querySelectorAll('[data-zh-header-layout]')]) {
            for (const child of layout.children) {
                if (child.tagName !== 'DIV') continue;
                const isSpacer = !child.textContent.trim() && !child.querySelector('button, a, input, svg, img, [role="dialog"]');
                if (isSpacer) child.setAttribute('data-zh-header-spacer', 'true');
                else child.removeAttribute('data-zh-header-spacer');
            }
        }
        nav.setAttribute('data-zh-header-leaf', 'nav');
        search.setAttribute('data-zh-header-leaf', 'search');
        // 移除旧模块写入的单独宽度和弹性参数，由统一布局管理。
        for (const el of [nav, search]) {
            ['flex', 'flex-grow', 'width', 'margin-left', 'margin-right'].forEach(key => el.style.removeProperty(key));
        }
        header.querySelectorAll('[data-zh-header-layout]').forEach(el => {
            if (el !== host && el !== nav && el !== search) el.style.removeProperty('display');
        });
        header.querySelectorAll('button, a, [role="button"]').forEach(control => {
            if (nav.contains(control) || search.contains(control) || !control.querySelector('svg')) return;
            const text = (control.textContent || '').replace(/\s/g, '');
            const label = control.getAttribute('aria-label') || control.getAttribute('title') || '';
            const href = control.getAttribute('href') || '';
            if (!/^(?:\d+条)?(?:消息|私信|通知)\d*$/.test(text) && !/^(?:\d+条)?(?:消息|私信|通知)$/.test(label) && !/^https:\/\/www\.zhihu\.com\/(?:messages|notifications)\/?$/.test(href)) return;
            control.setAttribute('data-zh-header-action', 'true');
            if (!control.getAttribute('aria-label')) control.setAttribute('aria-label', text.replace(/\d+/g, '') || label);
            control.querySelectorAll('span, div, sup, i, em').forEach(el => {
                if (el.children.length === 0 && /^\d+\+?$/.test(el.textContent.trim())) {
                    el.setAttribute('data-zh-header-badge', 'true');
                }
            });
            for (let el = control.parentElement; el && el !== row && el !== header; el = el.parentElement) {
                if (el.contains(nav) || el.contains(search)) break;
                el.setAttribute('data-zh-header-tool-path', 'true');
            }
        });
    }

    // ---------- 模块 1：顶栏头像置左 ----------
    function scanHeaderAvatar() {
        if (PERSONAL_LAYOUT.avatarAtStart) {
            const header = document.querySelector(SELECTORS.header);
            if (header) {
                const headerInner = header.querySelector(SELECTORS.headerInner) || header.firstElementChild;
                if (headerInner) {
                    if (headerInner.style.display === 'none') {
                        headerInner.style.display = 'flex';
                    }
                    let movedProfile = headerInner.querySelector(SELECTORS.movedAvatar);

                    // 核心：精准寻找当前登录用户本人的个人资料入口节点（优先知乎官方 profile 入口类名）
                    let profileBox = null;

                    // 1.1 优先查找知乎标准个人菜单容器（绝不会误抓作者吸顶栏）
                    const officialProfiles = Array.from(header.querySelectorAll(SELECTORS.profileEntry));
                    profileBox = officialProfiles.find(el => el !== movedProfile && !movedProfile?.contains(el)) || officialProfiles[0];

                    // 1.2 若未通过官方类名直接找到，严格在顶栏用户信息区（userInfo）内部寻找头像
                    if (!profileBox) {
                        const userInfo = header.querySelector(SELECTORS.userInfo);
                        if (userInfo) {
                            const allImgs = Array.from(userInfo.querySelectorAll('img')).filter(img => {
                                return img.classList.contains('AppHeader-profileAvatar') ||
                                       img.classList.contains('Avatar') ||
                                       img.closest('button, a');
                            });
                            const freshAvatar = allImgs.find(img => !movedProfile || !movedProfile.contains(img));
                            if (freshAvatar) {
                                let curr = freshAvatar;
                                while (curr.parentElement && curr.parentElement !== userInfo && curr.parentElement !== headerInner) {
                                    const p = curr.parentElement;
                                    if (p.children.length > 1 && Array.from(p.children).some(el => el !== curr && (el.textContent?.includes('消息') || el.textContent?.includes('私信') || el.querySelector('svg')))) {
                                        break;
                                    }
                                    curr = p;
                                }
                                profileBox = curr;
                            }
                        }
                    }

                    // 1.3 执行安全移动与保活
                    if (profileBox) {
                        // 如果已经在最左侧且依然是 headerInner 的第一项，无需重复操作
                        if (movedProfile === profileBox && headerInner.firstElementChild === profileBox) {
                            profileBox.style.setProperty('display', 'flex', 'important');
                            profileBox.style.setProperty('visibility', 'visible', 'important');
                        } else {
                            // 存在失效的旧节点时先清理
                            if (movedProfile && movedProfile !== profileBox) {
                                movedProfile.remove();
                            }

                            // 首次移动前记录原始位置，供关闭功能/总开关时精确还原
                            if (!profileBox.__zhOrigParent) {
                                profileBox.__zhOrigParent = profileBox.parentElement;
                                profileBox.__zhOrigNext = profileBox.nextElementSibling;
                            }

                            profileBox.classList.add('zh-moved-avatar');
                            profileBox.setAttribute('data-zh-moved-avatar', 'true');
                            profileBox.style.setProperty('display', 'flex', 'important');
                            profileBox.style.setProperty('visibility', 'visible', 'important');
                            profileBox.style.setProperty('opacity', '1', 'important');
                            profileBox.style.setProperty('order', '-9999', 'important');

                            headerInner.insertBefore(profileBox, headerInner.firstElementChild);
                            movedProfile = profileBox;
                        }
                    }
                }
            }
        } else {
            // 功能关闭：将已移动的头像放回原位
            restoreHeaderAvatar();
        }
    }

    // ---------- 模块 2：精简顶栏入口 ----------
    function scanHeaderItems() {
        if (!config.cleanHeaderItems) {
            // 功能关闭：还原本模块隐藏的顶栏元素与排版内联样式
            restoreHeaderItems();
            return;
        }

        const header = document.querySelector(SELECTORS.header);
        if (!header) return;

        header.querySelectorAll('a, button').forEach(el => {
            const txt = (el.innerText || el.textContent || '').trim();
            const href = el.getAttribute('href') || '';

            // 隐藏「直答」按钮
            if (txt.includes('直答') || href.includes('zhida.zhihu.com') || href.includes('zhida')) {
                el.style.setProperty('display', 'none', 'important');
                if (el.parentElement && el.parentElement.tagName === 'LI') {
                    el.parentElement.style.setProperty('display', 'none', 'important');
                }
            }

            // 隐藏「AI Works」导航链接
            if (el.tagName === 'A' && (/AI\s*Works/i.test(txt) || href.includes('ai-works') || href.includes('ai_works'))) {
                el.style.setProperty('display', 'none', 'important');
                if (el.parentElement && el.parentElement.tagName === 'LI') {
                    el.parentElement.style.setProperty('display', 'none', 'important');
                }
            }

            // 隐藏「故事」导航链接（href 仅匹配独立 /story 路径，避免误伤含 story 追踪参数的普通链接）
            let storyPath = '';
            try { storyPath = href ? new URL(href, location.origin).pathname : ''; } catch (e) { storyPath = ''; }
            const isStoryHref = /^\/story(\/|$)/.test(storyPath);
            if (el.tagName === 'A' && (txt === '故事' || (txt.startsWith('故事') && txt.length <= 4) || isStoryHref)) {
                el.style.setProperty('display', 'none', 'important');
                if (el.parentElement && el.parentElement.tagName === 'LI') {
                    el.parentElement.style.setProperty('display', 'none', 'important');
                }
            }

            // 隐藏「+」提问/创作按钮
            // 知乎当前 DOM：button.SearchBar-askDropdownButton（aria-label="创作"，内含 svg.ZDI--PlusFill24），
            // 位于搜索框旁的 .SearchBar-askContainer 内，顶栏右侧区域类名已全部变为 css-xxxx 哈希，不能依赖 AppHeader-userInfo 容器。
            if (el.tagName === 'BUTTON') {
                const aria = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const isPrimary = el.classList.contains('Button--primary');
                const isAskDropdown = el.classList.contains(SELECTORS.askButton.slice(1)) ||
                    el.closest(SELECTORS.askContainer) !== null;
                // 加号图标：仅认知乎图标库的 PlusFill 类名，不再用通用 Material 路径片段
                const hasPlusIcon = el.querySelector('svg.ZDI--PlusFill24, svg[class*="PlusFill"]') !== null;
                // 文字/语义识别；「创作」是当前「+」按钮的 aria-label
                const isAskSemantic = aria === '创作' || aria.includes('提问') || title.includes('提问') ||
                    txt === '提问' || txt === '创作' || txt === '+';
                // 保护：搜索按钮、头像入口、消息/私信按钮绝不隐藏
                const isProtected = el.classList.contains(SELECTORS.searchButton.slice(1)) ||
                    el.classList.contains('AppHeader-profileEntry') ||
                    el.querySelector('img') !== null ||
                    /搜索|消息|私信|通知/.test(aria + title);
                if (!isProtected && (isAskDropdown || isAskSemantic || (isPrimary && txt === '' && hasPlusIcon))) {
                    el.style.setProperty('display', 'none', 'important');
                    el.setAttribute('data-zh-hidden-ask', 'true');
                    // 同时隐藏其外层 askContainer，消除残留的占位间距
                    const askContainer = el.closest(SELECTORS.askContainer);
                    if (askContainer) {
                        askContainer.style.setProperty('display', 'none', 'important');
                        askContainer.setAttribute('data-zh-hidden-ask', 'true');
                    }
                }
            }
        });

        // 2.2 彻底清除“圈子”后面的竖线分隔条（安全类型检查）
        const allTabs = Array.from(header.querySelectorAll('a, li'));
        const circleTab = allTabs.find(t => t.textContent?.trim() === '圈子');
        if (circleTab) {
            const circleItem = circleTab.closest('li') || circleTab;
            const next = circleItem.nextElementSibling;
            if (next) {
                const nextClass = getSafeClassName(next);
                // 搜索框文字常为空，不能按文本长度将其误当作分隔条隐藏。
                if (nextClass.includes('divider') || /^[|丨]+$/.test(next.textContent.trim())) {
                    next.style.setProperty('display', 'none', 'important');
                }
            }
        }

        // 2.3 匹配所有纯文本竖线叶子节点
        header.querySelectorAll('span, li, i, em, div').forEach(el => {
            if (el.children.length === 0) {
                const txt = el.textContent ? el.textContent.trim() : '';
                if (txt && (txt === '|' || txt === '丨' || (txt.includes('|') && txt.length <= 4))) {
                    el.style.setProperty('display', 'none', 'important');
                }
            }
        });

        // 2.4 顶栏搜索框左移与弹性空间再分配（JS 内联兜底）
        const headerInner = header.querySelector(SELECTORS.headerInner) || header;
        if (headerInner) {
            headerInner.style.setProperty('display', 'flex', 'important');
            headerInner.style.setProperty('justify-content', 'flex-start', 'important');
        }
        const nav = header.querySelector(SELECTORS.headerNav);
        if (nav) {
            nav.style.setProperty('flex', '0 1 auto', 'important');
            nav.style.setProperty('flex-grow', '0', 'important');
            nav.style.setProperty('width', 'auto', 'important');
            nav.style.setProperty('margin-left', '0', 'important');
            nav.style.setProperty('margin-right', '0', 'important');
        }
        const searchBar = header.querySelector(SELECTORS.searchBar);
        if (searchBar) {
            searchBar.style.setProperty('margin-left', '12px', 'important');
            searchBar.style.setProperty('margin-right', '0', 'important');
            searchBar.style.setProperty('flex', '0 0 clamp(110px, 25vw, 240px)', 'important');
        }
        const userInfo = header.querySelector(SELECTORS.userInfo);
        if (userInfo) {
            userInfo.style.setProperty('margin-left', 'auto', 'important');
        }
    }

    // ---------- 模块 3：首页创作发布卡片（仅首页调用） ----------
    function scanHomePublishCard() {
        const mainCol = document.querySelector(SELECTORS.homeMainCol);
        const candidateCards = mainCol
            ? mainCol.querySelectorAll(SELECTORS.publishCardCandidates)
            : document.querySelectorAll('[class*="GlobalWrite"]');
        candidateCards.forEach(card => {
            if (card.classList.contains('TopstoryItem') || card.closest('.TopstoryItem')) return;
            // 已识别过的卡片直接复用标记，避免重复读 innerText 触发布局
            let isPublishCard = card.getAttribute('data-zh-publish-card') === 'true';
            if (!isPublishCard) {
                if (card.getAttribute('data-zh-publish-checked') === 'true') return;
                const txt = card.textContent || '';
                isPublishCard = txt.includes('分享此刻的想法') ||
                    (txt.includes('发想法') && (txt.includes('写回答') || txt.includes('写文章') || txt.includes('提问题')));
                if (!isPublishCard) {
                    card.setAttribute('data-zh-publish-checked', 'true');
                    return;
                }
            }

            card.setAttribute('data-zh-publish-card', 'true');
            if (config.hidePublishCard) {
                card.style.setProperty('display', 'none', 'important');
            } else {
                card.style.display = '';
                card.style.position = 'relative';
                if (!card.querySelector('.zh-card-close-btn')) {
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'zh-card-close-btn';
                    closeBtn.type = 'button';
                    closeBtn.title = '隐藏此卡片 (可在设置中重新开启)';
                    closeBtn.innerHTML = `
                        <svg viewBox="0 0 24 24">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    `;
                    closeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        config.hidePublishCard = true;
                        saveConfig(config);
                    });
                    card.appendChild(closeBtn);
                }
            }
        });
    }

    // ---------- 模块 4：低评论话题过滤（仅在推荐流生效，严格排除「关注」页） ----------
    // 关注页是用户自己关注的人的动态流，评论数天然偏低，且未展开时按钮文案多为「添加评论」，
    // 会被评论数解析逻辑当成 0 条评论隐藏，等于把用户关注的人整个屏蔽掉，因此必须整页跳过。
    function scanLowComments(page) {
        const onFollowFeed = !!(page && page.isFollowPage);
        if (config.hideLowComments && !onFollowFeed) {
            const storyItems = document.querySelectorAll(SELECTORS.topstoryItem);
            storyItems.forEach(item => {
                let commentCount = null;
                const actionBtns = item.querySelectorAll('.ContentItem-action, .ContentItem-actions button, button, a');
                for (const btn of actionBtns) {
                    const txt = (btn.innerText || btn.textContent || '').trim();
                    if (txt.includes('添加评论')) {
                        commentCount = 0;
                        break;
                    }
                    const match = txt.match(/([\d,]+)\s*条评论/);
                    if (match) {
                        const num = parseInt(match[1].replace(/,/g, ''), 10);
                        if (!isNaN(num)) {
                            commentCount = num;
                            break;
                        }
                    }
                    const aria = btn.getAttribute('aria-label') || '';
                    const ariaMatch = aria.match(/([\d,]+)\s*条评论/);
                    if (ariaMatch) {
                        const num = parseInt(ariaMatch[1].replace(/,/g, ''), 10);
                        if (!isNaN(num)) {
                            commentCount = num;
                            break;
                        }
                    }
                }

                if (commentCount !== null) {
                    if (commentCount < 10) {
                        item.style.setProperty('display', 'none', 'important');
                        item.setAttribute('data-zh-low-comments', 'true');
                    } else {
                        if (item.getAttribute('data-zh-low-comments') === 'true') {
                            item.style.display = '';
                            item.removeAttribute('data-zh-low-comments');
                        }
                    }
                }
            });
        } else {
            // 关闭开关，或处于「关注」页：把已隐藏的卡片全部还原
            document.querySelectorAll('[data-zh-low-comments="true"]').forEach(item => {
                item.style.removeProperty('display');
                item.removeAttribute('data-zh-low-comments');
            });
        }
    }

    // ---------- 模块 5：问题页头部对齐（仅问题页调用） ----------
    function scanQuestionHeader() {
        if (PERSONAL_LAYOUT.hideSidebar) {
            const qContent = document.querySelector(SELECTORS.questionContent);
            const qMain = document.querySelector(SELECTORS.questionMain);
            const answerCol = document.querySelector(SELECTORS.answerCol);

            if (qContent && qMain) {
                qContent.style.setProperty('position', 'relative', 'important');
                qContent.style.setProperty('padding-left', '0px', 'important');
                qMain.style.setProperty('padding-left', '0px', 'important');
                qMain.style.setProperty('box-sizing', 'border-box', 'important');

                qMain.style.setProperty('margin-left', 'auto', 'important');
                qMain.style.setProperty('margin-right', 'auto', 'important');
                qMain.style.setProperty('width', '100%', 'important');
                if (answerCol) {
                    document.documentElement.style.setProperty('--zh-main-col-width',
                        `${Math.round(answerCol.getBoundingClientRect().width)}px`);
                }
            }

            const qSide = document.querySelector(SELECTORS.questionSide);
            if (qSide && qContent) {
                qSide.style.setProperty('position', 'static', 'important');
                qSide.style.removeProperty('right');
                qSide.style.removeProperty('top');
            }
        } else {
            restoreQuestionHeaderLayout();
        }
    }

    // ---------- 模块 6：侧边栏显隐与主列居中 ----------
    function scanSidebar(page) {
        if (!PERSONAL_LAYOUT.hideSidebar) {
            // 侧栏展开：清除脚本写入的隐藏与居中内联样式
            document.querySelectorAll(SIDEBAR_SELECTORS.join(',')).forEach(el => {
                if (el.style.display === 'none') {
                    el.style.display = '';
                    el.style.width = '';
                }
            });
            document.querySelectorAll(SELECTORS.mainContainers).forEach(container => {
                const columns = Array.from(container.children).filter(
                    c => !c.id?.startsWith('zh-') && c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT'
                );
                if (columns.length >= 2) {
                    columns[1].style.display = '';
                    columns[1].style.width = '';
                }
            });
            const profileMainCol = document.querySelector(SELECTORS.profileMainCol);
            if (profileMainCol) {
                profileMainCol.style.marginLeft = '';
                profileMainCol.style.marginRight = '';
                profileMainCol.style.float = '';
                profileMainCol.style.width = '';
            }
            const profileMain = document.querySelector(SELECTORS.profileMain);
            if (profileMain) {
                profileMain.style.display = '';
                profileMain.style.justifyContent = '';
            }
            document.querySelectorAll('[data-zh-search-sidebar="true"]').forEach(el => {
                el.style.display = '';
                el.style.width = '';
                el.removeAttribute('data-zh-search-sidebar');
            });
            const searchMainRestore = document.querySelector(SELECTORS.searchMainCol);
            if (searchMainRestore) {
                searchMainRestore.style.marginLeft = '';
                searchMainRestore.style.marginRight = '';
                searchMainRestore.style.float = '';
            }
            // 专栏页还原：清除 flex 行、主列壳、侧栏壳上的内联样式与标记
            restorePostLayout();
            return;
        }

        document.querySelectorAll(SIDEBAR_SELECTORS.join(',')).forEach(el => {
            if (el.id !== 'zh-sidebar-toggle-handle' && el.id !== 'zh-beautifier-panel') {
                el.style.setProperty('display', 'none', 'important');
            }
        });

        // 结构级兜底：首页、问题页、个人/机构主页
        document.querySelectorAll(SELECTORS.mainContainers).forEach(container => {
            const columns = Array.from(container.children).filter(
                c => !c.id?.startsWith('zh-') && c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT'
            );
            if (columns.length >= 2) {
                columns[1].style.setProperty('display', 'none', 'important');
            }
        });

        // 专栏文章页结构级兜底（仅专栏页执行）
        if (page.isPostPage) scanPostLayout();

        // 个人/机构主页主列水平居中兜底（仅个人主页存在这些容器，其他页面查询为空，代价可忽略）
        const profileMainCol = document.querySelector(SELECTORS.profileMainCol);
        if (profileMainCol) {
            profileMainCol.style.setProperty('margin-left', 'auto', 'important');
            profileMainCol.style.setProperty('margin-right', 'auto', 'important');
            profileMainCol.style.setProperty('float', 'none', 'important');
            profileMainCol.style.setProperty('width', '100%', 'important');
        }
        const profileMain = document.querySelector(SELECTORS.profileMain);
        if (profileMain) {
            profileMain.style.setProperty('display', 'flex', 'important');
            profileMain.style.setProperty('justify-content', 'center', 'important');
        }

        // 搜索页专属侧边栏定位与彻底隐藏（仅搜索页执行，严格安全守卫）
        if (page.isSearchPage) scanSearchSidebar();
    }

    // ---------- 模块 6a：专栏页结构级居中 ----------
    // 真实布局：.Post-content > [哈希 flex 行] > [哈希主列 > article.Post-Main] + [哈希侧栏壳(296px, flex-shrink:0)]
    // 哈希类名随构建变化，这里以 article 为锚点向上定位 flex 行，再在其直接子级中找不含 article 的那个作为侧栏壳
    function scanPostLayout() {
        const article = document.querySelector(SELECTORS.postArticle);
        const postContent = article ? article.closest(SELECTORS.postContent) : null;
        if (!article || !postContent) return;

        // flex 行 = .Post-content 的直接子级中包含 article 的那个
        let flexRow = article;
        while (flexRow.parentElement && flexRow.parentElement !== postContent) {
            flexRow = flexRow.parentElement;
        }
        if (flexRow === article || flexRow.parentElement !== postContent) return;

        flexRow.style.setProperty('display', 'flex', 'important');
        flexRow.style.setProperty('justify-content', 'center', 'important');
        flexRow.setAttribute('data-zh-post-row', 'true');

        Array.from(flexRow.children).forEach(child => {
            if (child.id?.startsWith('zh-') || child.tagName === 'STYLE' || child.tagName === 'SCRIPT') return;
            if (child.contains(article)) {
                // 主列壳：清除 flex-grow，margin auto 居中
                child.style.setProperty('margin-left', 'auto', 'important');
                child.style.setProperty('margin-right', 'auto', 'important');
                child.style.setProperty('flex-grow', '0', 'important');
                child.setAttribute('data-zh-post-main', 'true');
                // 把正文卡片实际宽度写入 CSS 变量，供吸底操作栏跟随，避免硬编码 694px 与知乎写入的 width 不一致而反复重排
                const articleW = Math.round(article.getBoundingClientRect().width);
                if (articleW > 0) {
                    document.documentElement.style.setProperty('--zh-main-col-width', `${articleW}px`);
                }
            } else {
                // 侧栏壳：整个隐藏，杜绝 296px 占位
                child.style.setProperty('display', 'none', 'important');
                child.style.setProperty('width', '0', 'important');
                child.setAttribute('data-zh-post-sidebar', 'true');
            }
        });
    }

    // ---------- 模块 6b：搜索页侧边栏溯源隐藏（仅搜索页调用） ----------
    function scanSearchSidebar() {
        // 安全守卫：检测一个节点自身或其子树是否包含搜索结果卡片/正文
        const hasSearchResults = (node) => {
            if (!node) return false;
            if (node.matches?.(SELECTORS.searchResultSelector)) return true;
            return Boolean(node.querySelector?.(SELECTORS.searchResultSelector));
        };

        // 1. 优先隐藏所有明确匹配侧边栏类名且绝对不含搜索结果的容器
        const knownSideSelectors = [
            '.SearchSide-container', '.Search-sideColumn', '.SearchSideBar', '.SearchSide',
            '[class*="SearchSide"]', '[class*="searchSide"]', '[class*="Search-side"]', '[class*="search-side"]',
            '[class*="SearchSideColumn"]', '[class*="SearchSideBar"]', '[class*="searchSideBar"]',
            '[class*="SearchSections-side"]', '[class*="SearchSections-sidebar"]'
        ];
        document.querySelectorAll(knownSideSelectors.join(',')).forEach(el => {
            if (!hasSearchResults(el)) {
                el.style.setProperty('display', 'none', 'important');
                el.style.setProperty('width', '0', 'important');
                el.setAttribute('data-zh-search-sidebar', 'true');
            }
        });

        // 2. 特征词向上溯源：覆盖帮助中心、举报中心、服务热线、备案信息等通用侧栏
        const searchKeywords = [
            '大家都在搜', '申请开通知乎机构号', '知乎指南', '网上有害信息举报专区',
            '帮助中心', '服务热线', '举报中心', '违法和不良信息举报',
            '关于知乎', '知乎个人信息保护指引', '知乎协议', '适老化无障碍服务', '京ICP'
        ];
        const candidateEls = document.querySelectorAll('.Search-container span, .SearchSections span, [class*="Search"] span, [class*="Search"] a, [class*="Search"] h3, [class*="Search"] h4, footer, [class*="Footer"]');
        for (const el of candidateEls) {
            // 确保种子元素自身不处于任何搜索结果内容中
            if (hasSearchResults(el) || el.closest?.(SELECTORS.searchResultSelector)) {
                continue;
            }
            const txt = (el.innerText || el.textContent || '').trim();
            if (txt.length < 35 && searchKeywords.some(kw => txt.includes(kw))) {
                let curr = el;
                while (curr && curr.parentElement && curr.parentElement !== document.body && curr.parentElement.tagName !== 'MAIN') {
                    const parent = curr.parentElement;
                    // 安全铁律：当前被隐藏的容器自身绝对不能包含任何搜索结果
                    if (hasSearchResults(curr)) {
                        break;
                    }
                    // 当前容器是侧栏，其父容器应包含主内容（搜索结果），且当前容器自身不是主列
                    const parentHasMain = hasSearchResults(parent);
                    const isMainCol = curr.matches?.(SELECTORS.searchMainCol);
                    if (parentHasMain && !isMainCol) {
                        curr.style.setProperty('display', 'none', 'important');
                        curr.style.setProperty('width', '0', 'important');
                        curr.setAttribute('data-zh-search-sidebar', 'true');
                        break;
                    }
                    curr = parent;
                }
            }
        }

        // 3. 搜索结果主列安全居中（仅对确认包含搜索结果的主容器生效，不强加宽度与父级 flex，防排版崩坏）
        const sampleResult = document.querySelector(SELECTORS.searchResultSelector);
        const searchMainCol = sampleResult
            ? (sampleResult.closest(SELECTORS.searchMainCol) || sampleResult.closest('.Search-container > div, .SearchSections > div'))
            : document.querySelector('.SearchMain');
        if (searchMainCol) {
            searchMainCol.style.setProperty('margin-left', 'auto', 'important');
            searchMainCol.style.setProperty('margin-right', 'auto', 'important');
            searchMainCol.style.setProperty('float', 'none', 'important');
        }
    }

    // ---------- 模块 8：搜索净化 ----------
    function scanSearchClean() {
        if (!config.cleanSearch) {
            restoreSearchClean();
            return;
        }

        // A. 持续清空输入框内的轮播占位推荐词
        document.querySelectorAll(SELECTORS.searchInput).forEach(input => {
            if (input.placeholder && input.placeholder.trim() !== '') {
                input.placeholder = '';
                input.setAttribute('placeholder', '');
            }
        });

        // B. 按知乎原生分组类名精确区分「历史」与「热搜」
        //    历史分组 .SearchBar-groupItem--hisotry（知乎自己拼错），条目 .SearchBar-historyItem，标签栏 .SearchBar-historyLabel，清空 .SearchBar-historyDeleteAll
        //    热搜分组 .SearchBar-groupItem--topSearch，条目 .SearchBar-topSearchItem，条目 id 形如 AutoComplete<N>-topSearch-<i>
        //    教训：历史条目没有单独的删除按钮（只有分组级「清空」），不能靠「有删除按钮」识别历史；
        //          也绝不能在「判定无历史」后隐藏整个浮层，那会让用户以为搜索坏了。

        // B1. 历史：显式保护，清除任何残留的隐藏与误标
        const protectHistory = (el) => {
            if (!el) return;
            if (el.getAttribute('data-zh-hidden-hot') === 'true') el.removeAttribute('data-zh-hidden-hot');
            if (el.style.display === 'none') el.style.removeProperty('display');
            el.setAttribute('data-zh-search-history', 'true');
        };
        document.querySelectorAll(SELECTORS.searchHistoryGroup).forEach(protectHistory);
        document.querySelectorAll(SELECTORS.searchHistoryItem).forEach(protectHistory);
        document.querySelectorAll(SELECTORS.searchHistoryLabel).forEach(protectHistory);

        // B2. 热搜：分组与条目一并隐藏
        const hideHot = (el) => {
            if (!el || el.closest(SELECTORS.searchHistoryGroup)) return;
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute('data-zh-hidden-hot', 'true');
        };
        document.querySelectorAll(SELECTORS.searchTopGroup).forEach(hideHot);
        document.querySelectorAll(SELECTORS.searchTopItem).forEach(hideHot);

        // B3. 兜底：知乎未来若改掉分组类名，再按条目特征识别热搜，
        //     候选范围只取 [role="option"] 与 .AutoComplete-item，并显式跳过历史分组内部。
        //     依据：火苗图标类名 ZDI--FireFill24（知乎图标库实际存在）；条目 id 前缀 -topSearch-（真实输入框 aria-activedescendant）。
        //     注意：此前按 .SearchBar-title 定位「搜索发现」分组的逻辑已删除，知乎原生 CSS 中不存在该类名，也不存在任何「发现/推荐」分组类名。
        const menus = document.querySelectorAll(SELECTORS.searchMenu);
        menus.forEach(menu => {
            menu.querySelectorAll('.AutoComplete-item, [role="option"]').forEach(item => {
                if (item.closest(SELECTORS.searchHistoryGroup) || item.matches(SELECTORS.searchHistoryItem)) return;
                if (item.getAttribute('data-zh-hidden-hot') === 'true') return;
                const hasFireSvg = item.querySelector('svg[class*="FireFill"]') !== null;
                const itemCls = getSafeClassName(item);
                const isHotClass = itemCls.includes('topsearch') || itemCls.includes('hotsearch') || (item.getAttribute('data-type') || '').includes('hot');
                const isHotId = /-topSearch-/.test(item.id || '');
                if (hasFireSvg || isHotClass || isHotId) hideHot(item);
            });
        });
    }

    // 还原搜索净化模块写入的隐藏与标记（供关闭开关或总开关时调用）
    function restoreSearchClean() {
        try {
            document.querySelectorAll('[data-zh-hidden-hot="true"]').forEach(el => {
                el.style.removeProperty('display');
                el.removeAttribute('data-zh-hidden-hot');
            });
            document.querySelectorAll('[data-zh-search-history="true"]').forEach(el => {
                el.removeAttribute('data-zh-search-history');
            });
        } catch (e) {}
    }

    // ---------- 模块 10：看山 bot 屏蔽 ----------
    function scanKanshan(page) {
        if (!config.blockKanshan) return;

        document.querySelectorAll(SELECTORS.answerItem).forEach(item => {
            const authorEl = item.querySelector('.AuthorInfo');
            const authorText = authorEl ? authorEl.textContent : '';
            const authorHref = authorEl ? (authorEl.querySelector('a')?.href || '') : '';
            const fullText = item.innerText || '';

            const isKanshanAuthor = /看山|知乎看山|kanshan/i.test(authorHref) ||
                                   authorText.includes('看山') ||
                                   authorText.includes('知乎看山');

            const isKanshanBadge = item.querySelector('[class*="Kanshan"], [class*="kanshan"]') !== null ||
                                  /AI\s*(答主|总结|创作)|看山.*为您提供/i.test(fullText.substring(0, 200));

            if (isKanshanAuthor || isKanshanBadge) {
                item.setAttribute('data-is-kanshan', 'true');
                item.style.display = 'none';
            }
        });

        // 看山 bot 独立卡片识别：限定在问题页/首页主列区域内，只检查带 Card/region 特征的容器
        if (page.isQuestionPage || page.isHomePage) {
            const kanshanScope = document.querySelector('.Question-main, .Topstory-mainColumn, .Question-mainColumn') || document.body;
            const potentialKanshanBoxes = kanshanScope.querySelectorAll('.Card:not([data-is-kanshan]), [role="region"]:not([data-is-kanshan]), [class*="Kanshan"]:not([data-is-kanshan]), [class*="kanshan"]:not([data-is-kanshan])');
            potentialKanshanBoxes.forEach(box => {
                if (box.children.length > 0 && box.children.length < 8) {
                    const text = box.textContent || '';
                    if (
                        (text.includes('知乎看山') || (text.includes('看山') && text.includes('AI'))) &&
                        text.length < 500
                    ) {
                        box.setAttribute('data-is-kanshan', 'true');
                        box.style.display = 'none';
                    }
                }
            });
        }
    }

    // ---------- 模块 11：推广卡片与追踪链接净化 ----------
    function scanAds() {
        document.querySelectorAll(SELECTORS.adLinks).forEach(link => {
            const hostCard = link.closest('.TopstoryItem, .Card, [class*="Pc-Business-Card"], [class*="Business-Card"], [class*="TopFeedBanner"]') || link.parentElement;
            if (hostCard && hostCard !== document.body && hostCard !== document.documentElement) {
                hostCard.style.setProperty('display', 'none', 'important');
                hostCard.setAttribute('data-zh-blocked-ad', 'true');
            }
        });

        document.querySelectorAll(SELECTORS.adContainers).forEach(el => {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute('data-zh-blocked-ad', 'true');
        });
    }

    // ---------- 模块 11b：列表容器保活 ----------
    function scanMainListsRecovery() {
        document.querySelectorAll(SELECTORS.mainLists).forEach(wrapper => {
            if (wrapper.style.display === 'none' && !wrapper.getAttribute('data-zh-publish-card') && !wrapper.getAttribute('data-zh-blocked-ad')) {
                wrapper.style.display = '';
            }
        });
    }

    // ---------- 模块 12：高清原图 ----------
    function scanRawImages() {
        if (config.loadRawImage) {
            processRawImages();
        } else {
            restoreNormalImages();
        }
    }

    // ============================================================
    // 默认加载高清无水印原图模块（智能提取/还原知乎 Raw 原图）
    // ============================================================
    function convertToRawImageUrl(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            // 1. 去除 query 参数（如水印控制、尺寸控制、source 跟踪参数等）
            let clean = url.split('?')[0];

            // 2. 匹配知乎图片通用格式:
            // 支持 pic1~4.zhimg.com, picx.zhimg.com, pica.zhimg.com 等知乎图床
            // 典型有损/压缩路径:
            // https://picx.zhimg.com/80/v2-69f886d34bcf1ad7208d249d3c5097bc_720w.jpg
            // https://pic1.zhimg.com/50/v2-69f886d34bcf1ad7208d249d3c5097bc_hd.webp
            // https://pic3.zhimg.com/v2-69f886d34bcf1ad7208d249d3c5097bc_b.jpg
            // 目标无损原图: https://picx.zhimg.com/v2-69f886d34bcf1ad7208d249d3c5097bc_r.jpg
            const match = clean.match(/^(https?:\/\/[^\/]+\.zhimg\.com)(?:\/[0-9a-zA-Z]+)*?\/(v2-[0-9a-fA-F]+)(?:_[a-zA-Z0-9]+)?(\.[a-zA-Z0-9]+)$/);
            if (match) {
                const domain = match[1];
                const hash = match[2];
                const ext = match[3];
                return `${domain}/${hash}_r${ext}`;
            }
            return clean;
        } catch (e) {
            return url;
        }
    }

    function processRawImages() {
        if (config.enabled === false || !config.loadRawImage) return;

        // 查找所有候选正文与搜索结果图片（选择器集中定义于 SELECTORS.rawImages）
        const imgs = document.querySelectorAll(SELECTORS.rawImages);

        imgs.forEach(img => {
            // 严格排除头像、表情包、贴纸等小图标及脚本控制面板
            if (img.closest?.(
                '.Avatar, [class*="Avatar"], .UserAvatar, .AuthorInfo-avatar, ' +
                '[class*="emoticon"], [class*="sticker"], [class*="Sticker"], [class*="Emoji"], ' +
                '#zh-beautifier-panel, #zh-sidebar-dock, [class*="captcha"]'
            )) {
                return;
            }

            // 获取原图 URL
            let rawUrl = '';
            const dataOriginal = img.getAttribute('data-original');
            if (dataOriginal && dataOriginal.includes('zhimg.com')) {
                rawUrl = convertToRawImageUrl(dataOriginal);
            } else {
                const dataActual = img.getAttribute('data-actualsrc') || img.getAttribute('src');
                if (dataActual && dataActual.includes('zhimg.com') && !dataActual.startsWith('data:')) {
                    rawUrl = convertToRawImageUrl(dataActual);
                }
            }

            if (!rawUrl || !rawUrl.includes('zhimg.com')) return;

            // 如果当前已经加载为目标原图且标记完毕，跳过
            if (img.getAttribute('data-zh-raw-loaded') === 'true' && img.src === rawUrl) {
                return;
            }

            // 备份旧 src 用于容错与功能关闭时还原
            if (!img.getAttribute('data-zh-backup-src')) {
                const currentSrc = img.getAttribute('src');
                if (currentSrc && !currentSrc.startsWith('data:')) {
                    img.setAttribute('data-zh-backup-src', currentSrc);
                }
            }

            // 同步知乎原生懒加载属性，防止原生懒加载滚入时又覆盖回低清压缩图
            img.setAttribute('data-actualsrc', rawUrl);
            img.setAttribute('data-original', rawUrl);
            if (img.hasAttribute('data-lazy-src')) {
                img.setAttribute('data-lazy-src', rawUrl);
            }
            if (img.hasAttribute('srcset')) {
                img.removeAttribute('srcset');
            }

            // 绑定异常回退机制：若原图由于极特殊网络状况未能获取，自动切回备用图
            img.addEventListener('error', function onImgError() {
                img.removeEventListener('error', onImgError);
                const backup = img.getAttribute('data-zh-backup-src');
                if (backup && img.src !== backup) {
                    img.src = backup;
                }
            }, { once: true });

            // 替换主 src 并标记
            img.src = rawUrl;
            img.setAttribute('data-zh-raw-loaded', 'true');
        });
    }

    function restoreNormalImages() {
        document.querySelectorAll('img[data-zh-raw-loaded="true"]').forEach(img => {
            const backup = img.getAttribute('data-zh-backup-src');
            if (backup && img.src !== backup) {
                img.src = backup;
            }
            img.removeAttribute('data-zh-raw-loaded');
        });
    }

    // 聚焦与点击搜索输入框时节流触发扫描，杜绝重复过度开销
    let lastSearchFilterTime = 0;
    function triggerSearchFilter() {
        const now = Date.now();
        if (now - lastSearchFilterTime < 80) return;
        lastSearchFilterTime = now;
        scanAndFilterDOM();
        setTimeout(scanAndFilterDOM, 50);
    }

    document.addEventListener('focusin', (e) => {
        try {
            if (e.target && (e.target.matches?.('.SearchBar-input input, input[type="search"]') || e.target.closest?.('.SearchBar'))) {
                triggerSearchFilter();
            }
        } catch (e) {}
    });

    document.addEventListener('click', (e) => {
        try {
            if (e.target && e.target.closest?.('.SearchBar, .AppHeader-SearchBar')) {
                triggerSearchFilter();
            }
        } catch (e) {}
    });

    // 窗口缩放时自适应保持像素级对齐（节流：缩放期间每 150ms 最多执行一次，结束后再补一次）
    let resizeTimer = null;
    let lastResizeRun = 0;
    window.addEventListener('resize', () => {
        const now = Date.now();
        if (now - lastResizeRun >= 150) {
            lastResizeRun = now;
            try { scanAndFilterDOM(); } catch (e) {}
        }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            lastResizeRun = Date.now();
            try { scanAndFilterDOM(); } catch (e) {}
        }, 150);
    }, { passive: true });

    // 防抖监听 DOM 变动与属性变动
    // 自触发抑制：scanAndFilterDOM 自身的 setAttribute/appendChild 也会唤醒 observer，
    // 这里过滤掉仅由脚本自身标记（data-zh-* / data-is-kanshan / zh- 前缀节点）引发的记录，打断无意义循环
    let mutationTimer = null;
    const isSelfMutation = (m) => {
        if (m.type === 'attributes') {
            return m.attributeName !== 'placeholder' && !(m.attributeName === 'class' && m.target.closest?.('.Comments-container, .CommentsV2'));
        }
        // childList：全部新增节点都是脚本自身创建的 UI 时视为自触发
        const added = m.addedNodes;
        if (!added || added.length === 0) return m.removedNodes.length > 0 && Array.from(m.removedNodes).every(n => n.nodeType !== 1 || /^zh-/.test(n.id || '') || (n.classList && n.classList.contains('zh-card-close-btn')));
        return Array.from(added).every(n => n.nodeType !== 1 || /^zh-/.test(n.id || '') || (n.classList && (n.classList.contains('zh-card-close-btn') || n.classList.contains('zh-b-mask'))));
    };
    const observer = new MutationObserver((records) => {
        if (mutationTimer) return;
        let meaningful = false;
        for (let i = 0; i < records.length; i++) {
            if (!isSelfMutation(records[i])) { meaningful = true; break; }
        }
        if (!meaningful) return;
        mutationTimer = setTimeout(() => {
            scanAndFilterDOM();
            mutationTimer = null;
        }, 120);
    });

    function startObserver() {
        try {
            const target = document.body || document.documentElement;
            if (target) {
                observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder', 'class'] });
                scanAndFilterDOM();
                scheduleHealthCheck();
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    if (document.body) {
                        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder', 'class'] });
                    }
                    scanAndFilterDOM();
                    scheduleHealthCheck();
                });
            }
        } catch (e) {}
    }

    // 始终可访问的收起入口：只代理当前视口内正文的原生按钮，不更改 React 状态。
    let readingCollapseButton = null;
    let readingCollapseTarget = null;
    let collapseFrame = 0;

    function updateReadingCollapse() {
        collapseFrame = 0;
        if (!document.body) return;
        let target = null;
        let bestDistance = Infinity;
        let collapseLabel = '收起全文 ↑';
        if (config.enabled !== false) {
            const candidates = document.querySelectorAll(
                '.ContentItem button, .RichContent button, .ContentItem-rightButton, .RichContent-collapsedText, .ContentItem [role="button"], .RichContent [role="button"], .RichContent a'
            );
            const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
            const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
            for (const button of candidates) {
                const label = (button.textContent || button.getAttribute('aria-label') || '').replace(/[\s\u200b-\u200d\ufeff]/g, '');
                if (!/^收起(?:全文|内容|回答)?[↑⌃︿^]*$/.test(label) || button.disabled) continue;
                const style = getComputedStyle(button);
                if (style.display === 'none' || style.visibility === 'hidden' || !button.getClientRects().length) continue;
                const item = button.closest('.ContentItem') || button.closest('.RichContent');
                if (!item) continue;
                // 跳过评论区折叠，避免误收起其他模块。
                if (button.closest('.Comments-container, .CommentsV2, [class*="CommentList"]')) continue;
                const rect = item.getBoundingClientRect();
                if (rect.bottom <= 64 || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= viewportWidth) continue;
                const distance = Math.abs(Math.max(64, rect.top) - viewportHeight * 0.3);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    target = button;
                }
            }
        }
        // 评论打开时直接代理原生评论开关，不依赖站点的悬浮框动画是否触发。
        if (config.enabled !== false) {
            const commentControls = document.querySelectorAll('button, a, [role="button"]');
            let commentDistance = Infinity;
            for (const control of commentControls) {
                const label = ((control.textContent || '') + ' ' + (control.getAttribute?.('aria-label') || '')).replace(/[\s\u200b-\u200d\ufeff]/g, '');
                if (control.id === 'zh-reading-collapse' || !/收起.*评论|关闭评论/.test(label)) continue;
                control.removeAttribute?.('data-zh-comment-collapse');
                const isAction = control.closest('.ContentItem-actions, .RichContent-actions') || control.classList?.contains('ContentItem-action');
                const isFloating = !isAction && Boolean(control.querySelector?.('svg[class*="ArrowUp"]'));
                if (isFloating) {
                    control.setAttribute('data-zh-comment-floating', 'true');
                    for (let surface = control.parentElement; surface && surface !== document.body; surface = surface.parentElement) {
                        if (surface.querySelectorAll('button, a, input, textarea, [contenteditable]').length !== 1 || surface.textContent.trim() !== control.textContent.trim()) break;
                        if (!surface.hasAttribute('data-zh-comment-floating-surface')) surface.setAttribute('data-zh-comment-floating-surface', 'true');
                    }
                } else control.removeAttribute('data-zh-comment-floating');
                const style = getComputedStyle(control);
                const hiddenByProxy = control.closest('[data-zh-comment-proxy-host]');
                if (!hiddenByProxy && (style.display === 'none' || style.visibility === 'hidden' || !control.getClientRects().length)) continue;
                const item = control.closest('.ContentItem') || control.closest('.AnswerItem');
                if (!item) continue;
                const rect = item.getBoundingClientRect();
                const height = document.documentElement.clientHeight || window.innerHeight;
                const width = document.documentElement.clientWidth || window.innerWidth;
                if (rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width) {
                    const distance = Math.abs(Math.max(64, rect.top) - height * .3);
                    if (distance < commentDistance) {
                        commentDistance = distance;
                        target = control;
                        collapseLabel = '收起评论 ↑';
                    }
                }
            }
        }
        // 我们已有就近收起入口时，隐藏站点那一套悬浮框及其单按钮包装层。
        const nativeHosts = new Set();
        if (target && collapseLabel === '收起评论 ↑') {
            const item = target.closest('.ContentItem, .AnswerItem');
            item?.querySelectorAll('[data-zh-comment-floating="true"]').forEach(control => {
                let host = control;
                for (let parent = control.parentElement; parent && parent !== item; parent = parent.parentElement) {
                    if (parent.querySelectorAll('button, a, input, textarea, [contenteditable]').length !== 1 || parent.textContent.trim() !== control.textContent.trim()) break;
                    host = parent;
                }
                nativeHosts.add(host);
            });
        }
        document.querySelectorAll('[data-zh-comment-proxy-host]').forEach(host => {
            if (!nativeHosts.has(host)) host.removeAttribute('data-zh-comment-proxy-host');
        });
        nativeHosts.forEach(host => {
            if (!host.hasAttribute('data-zh-comment-proxy-host')) host.setAttribute('data-zh-comment-proxy-host', 'true');
        });
        readingCollapseTarget = target;
        if (!readingCollapseButton && target) {
            readingCollapseButton = document.createElement('button');
            readingCollapseButton.id = 'zh-reading-collapse';
            readingCollapseButton.type = 'button';
            readingCollapseButton.textContent = collapseLabel;
            readingCollapseButton.setAttribute('aria-label', collapseLabel.replace(' ↑', ''));
            readingCollapseButton.addEventListener('click', () => {
                // 点击前重新选取，避免滚动或前端更新后引用已过期。
                updateReadingCollapse();
                const nativeButton = readingCollapseTarget;
                if (nativeButton && nativeButton.isConnected) nativeButton.click();
                scheduleReadingCollapse();
            });
            document.body.appendChild(readingCollapseButton);
        }
        if (readingCollapseButton) {
            if (readingCollapseButton.textContent !== collapseLabel) {
                readingCollapseButton.textContent = collapseLabel;
                readingCollapseButton.setAttribute('aria-label', collapseLabel.replace(' ↑', ''));
            }
            if (target) {
                const column = target.closest('.Topstory-mainColumn, .Question-mainColumn, .SearchMain, .Profile-mainColumn, .Post-Main, .Post-NormalMain') || target.closest('.ContentItem, .RichContent');
                if (column) {
                    const rect = column.getBoundingClientRect();
                    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
                    const right = Math.max(12, Math.round(viewportWidth - rect.right + 12));
                    const maxWidth = Math.max(0, Math.floor(Math.min(viewportWidth, rect.width) - 24));
                    readingCollapseButton.style.setProperty('--zh-collapse-right', `${right}px`);
                    readingCollapseButton.style.setProperty('--zh-collapse-max-width', `${maxWidth}px`);
                }
            }
            readingCollapseButton.hidden = !target;
        }
    }

    function scheduleReadingCollapse() {
        if (!collapseFrame) collapseFrame = requestAnimationFrame(updateReadingCollapse);
    }

    window.addEventListener('scroll', scheduleReadingCollapse, { passive: true });
    window.addEventListener('resize', scheduleReadingCollapse, { passive: true });
    document.addEventListener('click', scheduleReadingCollapse);
    // 展开也可能由键盘或异步渲染触发；独立观察，不写入正文节点。
    const collapseObserver = new MutationObserver(records => {
        if (records.some(record => !record.target.closest?.('#zh-reading-collapse'))) {
            scheduleReadingCollapse();
        }
    });
    collapseObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-expanded', 'style'],
        characterData: true
    });
    scheduleReadingCollapse();

    startObserver();

    // ==========================================
    // 可视化控制开关界面与右侧边沿双联工具坞（设置 ⚙️ + 侧栏折叠 ◀️）
    // ==========================================

    const PANEL_ID = 'zh-simplify-panel';
    const SIDE_DOCK_ID = 'zh-side-dock';
    const SETTINGS_HANDLE_ID = 'zh-dock-settings-btn';
    const BACK_TO_TOP_BTN_ID = 'zh-back-to-top';

    function injectUI() {
        if (document.getElementById(PANEL_ID)) return;

        // 注入 UI 交互专用样式
        const uiStyle = document.createElement('style');
        uiStyle.textContent = `
        /* 两枚固定大小的低对比工具按钮，避免悬停时扩宽挤动页面。 */
        #${SIDE_DOCK_ID} {
            position: fixed !important;
            right: max(10px, calc((100vw - 1000px) / 2 - 44px)) !important;
            bottom: max(124px, calc(env(safe-area-inset-bottom) + 108px)) !important;
            width: 30px !important;
            display: flex !important; flex-direction: column !important; align-items: center !important;
            background: var(--zh-tool-bg, #edf0f3) !important;
            color: var(--zh-tool-fg, #727b86) !important;
            border: 0 !important; border-radius: 9px !important;
            box-shadow: none !important; z-index: 99998 !important;
            opacity: .65; transition: opacity .16s ease;
        }
        #${SIDE_DOCK_ID}:hover, #${SIDE_DOCK_ID}:focus-within { opacity: 1; }
        .zh-dock-btn {
            display: flex !important; align-items: center !important; justify-content: center !important;
            width: 30px !important; height: 30px !important;
            padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 7px;
            color: inherit !important; background: transparent !important; cursor: pointer;
        }
        .zh-dock-btn svg {
            display: block !important; width: 16px !important; height: 16px !important;
            fill: none !important; stroke: currentColor; stroke-width: 1.7;
            stroke-linecap: round; stroke-linejoin: round;
        }
        .zh-dock-btn:focus { outline: none; box-shadow: none; }
        .zh-dock-btn:hover, .zh-dock-btn:focus-visible { background: var(--zh-tool-hover, #dfe5eb) !important; }
        .zh-dock-btn:active { opacity: .65; }
        .zh-dock-divider { width: 14px; height: 1px; background: currentColor; opacity: .18; }
        #${BACK_TO_TOP_BTN_ID}, #${BACK_TO_TOP_BTN_ID}-divider { display: none !important; }
        #${BACK_TO_TOP_BTN_ID}.visible { display: flex !important; }
        #${BACK_TO_TOP_BTN_ID}-divider.visible { display: block !important; }

        /* 3. 抽屉控制面板 */
        #${PANEL_ID} {
            position: fixed;
            right: -360px;
            top: 0;
            width: min(340px, 100vw);
            height: 100vh;
            background: #ffffff;
            box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
            z-index: 100000;
            transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #333;
        }
        #${PANEL_ID}.open {
            right: 0;
        }
        .zh-b-header {
            padding: 20px 24px;
            border-bottom: 1px solid #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .zh-b-title {
            font-size: 17px;
            font-weight: 600;
            color: #121212;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .zh-b-close {
            cursor: pointer;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #888;
            transition: all 0.2s;
        }
        .zh-b-close:hover {
            background: #f4f4f4;
            color: #333;
        }
        .zh-b-body {
            padding: 16px 24px;
            flex: 1;
            overflow-y: auto;
        }

        /* 启用静阅卡片专属样式 */
        .zh-b-master-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 16px;
            margin-bottom: 16px;
            border-radius: 10px;
            background: linear-gradient(135deg, rgba(0, 132, 255, 0.08) 0%, rgba(0, 132, 255, 0.02) 100%);
            border: 1px solid rgba(0, 132, 255, 0.22);
            transition: all 0.25s ease;
        }
        .zh-b-master-card.disabled {
            background: #f7f8fa;
            border-color: #e4e7ed;
        }
        .zh-b-master-info {
            flex: 1;
            padding-right: 12px;
        }
        .zh-b-master-title {
            font-size: 15px;
            font-weight: 700;
            color: #121212;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .zh-b-master-desc {
            font-size: 12px;
            color: #8590a6;
            margin-top: 3px;
        }
        .zh-b-sub-options {
            transition: opacity 0.25s ease, filter 0.25s ease;
        }
        .zh-b-sub-options.disabled {
            opacity: 0.42;
            pointer-events: none;
            filter: grayscale(0.7);
        }

        /* 背景控制专属卡片 */
        .zh-b-section {
            padding: 14px 0 16px;
            border-bottom: 1px solid #f0f0f0;
            margin-bottom: 6px;
        }
        .zh-b-section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .zh-b-item {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            padding: 14px 0;
            border-bottom: 1px solid #f9f9f9;
        }
        .zh-b-item-info {
            flex: 1;
            padding-right: 16px;
        }
        .zh-b-item-name {
            font-size: 14px;
            font-weight: 500;
            color: #222;
            margin-bottom: 4px;
        }
        .zh-b-item-desc {
            font-size: 12px;
            color: #888;
            line-height: 1.4;
        }

        /* 现代 iOS 风格 Switch */
        .zh-switch {
            position: relative;
            display: inline-block;
            width: 44px;
            height: 24px;
            flex-shrink: 0;
            margin-top: 2px;
        }
        .zh-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .zh-slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background-color: #e4e7ed;
            transition: .25s ease;
            border-radius: 24px;
        }
        .zh-slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: .25s ease;
            border-radius: 50%;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }
        input:checked + .zh-slider {
            background-color: #0084ff;
        }
        input:checked + .zh-slider:before {
            transform: translateX(20px);
        }

        .zh-b-footer {
            padding: 16px 24px;
            border-top: 1px solid #f0f0f0;
            display: flex;
            gap: 12px;
        }
        .zh-b-btn {
            flex: 1;
            padding: 9px 0;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            border: 1px solid #dcdfe6;
            background: #fff;
            color: #555;
        }
        .zh-b-btn:hover {
            background: #f7f9fa;
            border-color: #c6e2ff;
            color: #0084ff;
        }
        .zh-b-mask {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0,0,0,0.25);
            z-index: 99999;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease;
        }
        .zh-b-mask.open {
            opacity: 1;
            pointer-events: auto;
        }
        #${PANEL_ID} button { font-family: inherit; }
        #${PANEL_ID} button:focus { outline: none; box-shadow: none; }
        #${PANEL_ID} button:focus-visible { background: #e6edf5 !important; }
        #${PANEL_ID} .zh-b-close { border: 0; background: transparent; padding: 0; }
        #${PANEL_ID} .zh-switch:has(input:focus-visible) .zh-slider { background: #b6c9df; }

        `;
        document.head.appendChild(uiStyle);

        // 私人阅读工具条：仅保留阅读偏好与自动出现的返回顶部。
        const dock = document.createElement('div');
        dock.id = SIDE_DOCK_ID;
        dock.setAttribute('role', 'toolbar');
        dock.setAttribute('aria-label', '静阅工具');
        dock.innerHTML = `
            <button type="button" id="${SETTINGS_HANDLE_ID}" class="zh-dock-btn" title="阅读偏好" aria-label="阅读偏好">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg>
            </button>
            <div class="zh-dock-divider" id="${BACK_TO_TOP_BTN_ID}-divider"></div>
            <button type="button" id="${BACK_TO_TOP_BTN_ID}" class="zh-dock-btn" title="返回顶部" aria-label="返回顶部">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>
            </button>
        `;
        dock.querySelector(`#${SETTINGS_HANDLE_ID}`).addEventListener('click', () => openPanel());

        // 返回顶部在滚动超过 300px 时自动显示。
        const backToTopBtn = dock.querySelector(`#${BACK_TO_TOP_BTN_ID}`);
        const backToTopDivider = dock.querySelector(`#${BACK_TO_TOP_BTN_ID}-divider`);

        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        });

        function updateBackToTopVisibility() {
            const show = config.enabled !== false && window.scrollY > 300;
            backToTopBtn.classList.toggle('visible', show);
            backToTopDivider.classList.toggle('visible', show);
        }

        window.addEventListener('scroll', updateBackToTopVisibility, { passive: true });

        // 3. 遮罩层
        const mask = document.createElement('div');
        mask.className = 'zh-b-mask';

        // 4. 抽屉控制面板
        const panel = document.createElement('div');
        panel.id = PANEL_ID;

        const optionsMeta = [
            { key: 'cleanHeaderItems', title: '精简顶栏多余入口', desc: '隐藏顶栏「直答」按钮、蓝色「+」提问按钮、导航项「AI Works」、「故事」及分隔线' },
            { key: 'hidePublishCard', title: '隐藏发想法/创作卡片', desc: '隐藏首页顶部的「发想法 / 提问题 / 写回答 / 写文章」卡片' },
            { key: 'blueCardDivider', title: '话题卡片蓝色分割线', desc: '在首页每个问答话题之间添加精致的知乎蓝线条间隔' },
            { key: 'hideLowComments', title: '过滤低评论话题 (<10条)', desc: '自动隐藏首页推荐中评论数量少于 10 条的低讨论度内容（「关注」页为好友动态流，自动跳过不误伤）' },
            { key: 'blockKanshan', title: '关闭「看山 bot」', desc: '隐藏知乎看山 AI 总结、AI 答主回答与相关问答模块' },
            { key: 'cleanSearch', title: '净化搜索推荐与热搜发现', desc: '清空搜索框轮播热搜词，并移除下拉菜单中的「搜索发现」与实时热搜推荐' },
            { key: 'loadRawImage', title: '默认加载高清原图', desc: '绕过知乎有损压缩与低清限制，正文与搜索配图均默认加载高清无水印原图' },
            { key: 'debug', title: '调试模式', desc: '在浏览器控制台输出各模块的详细日志，排查问题时开启（选择器失配告警始终输出，不受此项影响）' }
        ];

        let itemsHtml = optionsMeta.map(item => `
            <div class="zh-b-item">
                <div class="zh-b-item-info">
                    <div class="zh-b-item-name">${item.title}</div>
                    <div class="zh-b-item-desc">${item.desc}</div>
                </div>
                <label class="zh-switch">
                    <input type="checkbox" data-key="${item.key}" ${config[item.key] ? 'checked' : ''}>
                    <span class="zh-slider"></span>
                </label>
            </div>
        `).join('');

        panel.innerHTML = `
            <div class="zh-b-header">
                <div class="zh-b-title">
                    阅读偏好
                </div>
                <button type="button" class="zh-b-close" id="zh-b-close-btn" aria-label="关闭阅读偏好">&times;</button>
            </div>
            <div class="zh-b-body">
                <!-- 脚本全局总开关卡片 -->
                <div class="zh-b-master-card ${config.enabled !== false ? '' : 'disabled'}" id="zh-b-master-card">
                    <div class="zh-b-master-info">
                        <div class="zh-b-master-title">
                            <svg style="width:16px;height:16px;fill:#0084ff" viewBox="0 0 24 24"><path d="M13 2.05v3.03c3.39.49 6 3.39 6 6.92 0 3.87-3.13 7-7 7s-7-3.13-7-7c0-3.53 2.61-6.43 6-6.92V2.05C6.94 2.58 3 6.84 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-5.16-3.94-9.42-8-9.95zM11 2v10h2V2h-2z"/></svg>
                            启用静阅
                        </div>
                        <div class="zh-b-master-desc">暂停后恢复网站原有外观</div>
                    </div>
                    <label class="zh-switch">
                        <input type="checkbox" id="zh-master-switch" ${config.enabled !== false ? 'checked' : ''}>
                        <span class="zh-slider"></span>
                    </label>
                </div>

                <!-- 子项控制容器（总开关关闭时整体置灰禁用） -->
                <div class="zh-b-sub-options ${config.enabled !== false ? '' : 'disabled'}" id="zh-b-sub-options">
                    <div class="zh-b-section">
                        <div class="zh-b-item-name" id="zh-theme-label">阅读配色</div>
                        <div class="zh-theme-buttons" role="group" aria-labelledby="zh-theme-label">
                            ${Object.entries(READING_THEMES).map(([key, theme]) => `<button type="button" class="zh-theme-button" data-theme="${key}" aria-pressed="${config.readingTheme === key}">${theme.name}</button>`).join('')}
                        </div>
                    </div>
                    <!-- 常规功能开关列表 -->
                    ${itemsHtml}
                </div>
            </div>
            <div class="zh-b-footer">
                <button type="button" class="zh-b-btn" id="zh-b-reset">重置偏好</button>
                <button type="button" class="zh-b-btn" style="background:#e5efff;color:#1763bf;border-color:transparent;" id="zh-b-ok">完成</button>
            </div>
        `;

        if (document.body) {
            document.body.appendChild(dock);
            document.body.appendChild(mask);
            document.body.appendChild(panel);
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(dock);
                document.body.appendChild(mask);
                document.body.appendChild(panel);
            });
        }

        updateBackToTopVisibility();
        updateDockTheme();
        const siteThemeObserver = new MutationObserver(() => {
            if (config.readingTheme === 'original' || config.enabled === false) updateDockTheme();
        });
        for (const element of [document.documentElement, document.body]) {
            if (element) siteThemeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        }

        // 交互逻辑
        let previousFocus = null;
        function openPanel() {
            previousFocus = document.activeElement === document.body ? dock.querySelector(`#${SETTINGS_HANDLE_ID}`) : document.activeElement;
            panel.classList.add('open');
            mask.classList.add('open');
            panel.querySelector('#zh-b-close-btn').focus();
        }

        function closePanel() {
            panel.classList.remove('open');
            mask.classList.remove('open');
            if (previousFocus?.isConnected) previousFocus.focus();
        }

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && panel.classList.contains('open')) closePanel();
        });
        mask.addEventListener('click', closePanel);
        panel.querySelector('#zh-b-close-btn').addEventListener('click', closePanel);
        panel.querySelector('#zh-b-ok').addEventListener('click', closePanel);

        function syncThemeButtons() {
            panel.querySelectorAll('[data-theme]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.theme === config.readingTheme));
            });
        }
        panel.querySelectorAll('[data-theme]').forEach(button => {
            button.addEventListener('click', () => {
                config.readingTheme = button.dataset.theme;
                saveConfig(config);
                syncThemeButtons();
            });
        });

        // 总开关控制联动
        const masterSwitch = panel.querySelector('#zh-master-switch');
        const masterCard = panel.querySelector('#zh-b-master-card');
        const subOptions = panel.querySelector('#zh-b-sub-options');

        function updateMasterState(enabled) {
            config.enabled = enabled;
            saveConfig(config);
            if (enabled) {
                masterCard.classList.remove('disabled');
                subOptions.classList.remove('disabled');
            } else {
                masterCard.classList.add('disabled');
                subOptions.classList.add('disabled');
            }
            updateBackToTopVisibility();
        }

        masterSwitch.addEventListener('change', (e) => {
            updateMasterState(e.target.checked);
        });

        // 开关变动事件（仅绑定带 data-key 的功能开关；总开关由 updateMasterState 单独处理，避免写入 config["null"] 并重复保存）
        panel.querySelectorAll('input[type="checkbox"][data-key]').forEach(input => {
            input.addEventListener('change', (e) => {
                const key = e.target.getAttribute('data-key');
                if (!key || !(key in DEFAULT_CONFIG)) return;
                config[key] = e.target.checked;
                saveConfig(config);


            });
        });

        // 重置配置
        panel.querySelector('#zh-b-reset').addEventListener('click', () => {
            config = { ...DEFAULT_CONFIG };
            saveConfig(config);
            syncThemeButtons();
            masterSwitch.checked = true;
            updateMasterState(true);
            panel.querySelectorAll('input[type="checkbox"][data-key]').forEach(input => {
                const key = input.getAttribute('data-key');
                input.checked = !!config[key];
            });
            updateBackToTopVisibility();
        });

        // 对外暴露打开面板方法：挂到页面真实 window（unsafeWindow），沙箱模式下页面脚本/控制台也能调用
        try {
            targetWin.__openZhihuBeautifierPanel = openPanel;
        } catch (e) {
            window.__openZhihuBeautifierPanel = openPanel;
        }

    }

    // 页面加载完成后注入设置 UI
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }
    // 测试钩子：仅在 window.__ZH_TEST__ 为 true 时暴露内部函数，生产环境完全不生效
    if (targetWin.__ZH_TEST__) {
        targetWin.__zhInternals = {
            generateCSS: generateCSS,
            scanAndFilterDOM: scanAndFilterDOM,
            getPageInfo: getPageInfo,
            restoreNativeDOM: restoreNativeDOM,
            collectHealthIssues: collectHealthIssues,
            SELECTORS: SELECTORS,
            SIDEBAR_SELECTORS: SIDEBAR_SELECTORS,
            getConfig: function () { return config; },
            setConfig: function (c) { config = c; }
        };
    }
})();
