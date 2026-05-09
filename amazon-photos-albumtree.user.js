// ==UserScript==
// @name         Amazon Photos AlbumTree
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Amazon Photos アルバムを階層フォルダで管理 (iPhone向け)
// @match        https://www.amazon.co.jp/photos/*
// @match        https://www.amazon.com/photos/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'amazon-photo-folder-map';
    let currentAlbumName = null;
    let currentPath = [];
    let explorerActive = false;
    let albumCache = [];       // 取得済みアルバムのキャッシュ
    let domObserver = null;    // MutationObserver

    // =====================
    // ストレージ
    // =====================
    function loadFolderMap() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    function saveFolderMap(map) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    }

    // =====================
    // Amazonアルバムデータ取得
    // =====================

    /**
     * 改善点①: MutationObserver でDOM変化を監視し、
     * album-container が追加されるたびにキャッシュを更新する。
     * setInterval による全量再スキャンをなくしてパフォーマンスを改善。
     */
    function startAlbumObserver() {
        if (domObserver) return;

        const scanAndCache = () => {
            const found = scanAlbumsFromDOM();
            if (found.length > 0) {
                mergeIntoCache(found);
                if (explorerActive) renderExplorer();
            }
        };

        // 初回スキャン
        scanAndCache();

        domObserver = new MutationObserver((mutations) => {
            // album-container が含まれる変化だけ処理
            const relevant = mutations.some(m =>
                [...m.addedNodes].some(n =>
                    n.nodeType === 1 && (
                        n.classList?.contains('album-container') ||
                        n.querySelector?.('.album-container')
                    )
                )
            );
            if (relevant) scanAndCache();
        });

        domObserver.observe(document.body, { childList: true, subtree: true });
    }

    function scanAlbumsFromDOM() {
        const albums = [];
        document.querySelectorAll('.album-container').forEach(container => {
            const titleEl = container.querySelector('h5.album-title');
            if (!titleEl) return;
            const title = titleEl.getAttribute('title') || titleEl.textContent.trim();
            if (!title) return;

            // 改善点②: bg-image の background-image に加え、
            // img タグ・data-src も候補にしてサムネを確実に取得する
            let thumbnail = '';
            const bgEl = container.querySelector('.bg-image');
            if (bgEl) {
                // (a) インラインスタイルが既に設定されている場合
                const inlineStyle = bgEl.style.backgroundImage;
                if (inlineStyle && inlineStyle !== 'none') {
                    thumbnail = inlineStyle.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
                }
                // (b) まだスタイルが空 → data-src 属性を試みる
                if (!thumbnail) {
                    thumbnail = bgEl.dataset.src || bgEl.getAttribute('data-bg') || '';
                }
                // (c) 子の img タグ
                if (!thumbnail) {
                    const img = bgEl.querySelector('img');
                    if (img) thumbnail = img.src || img.dataset.src || '';
                }
            }
            // (d) container 内の img タグ（bgEl が無い場合）
            if (!thumbnail) {
                const img = container.querySelector('img');
                if (img) thumbnail = img.src || img.dataset.src || '';
            }

            // アルバムリンク取得
            const parent = container.parentElement;
            const link = parent?.querySelector('a.node-link') || container.closest('a');
            const href = link?.href || '';

            albums.push({ title, thumbnail, href });
        });
        return albums;
    }

    /**
     * 新たに見つかったアルバムをキャッシュにマージする。
     * 既存エントリはサムネが空の場合だけ上書きして情報を補完する。
     */
    function mergeIntoCache(newAlbums) {
        const titleIndex = {};
        albumCache.forEach((a, i) => { titleIndex[a.title] = i; });

        newAlbums.forEach(a => {
            if (a.title in titleIndex) {
                const idx = titleIndex[a.title];
                // サムネが未取得だった場合は更新
                if (!albumCache[idx].thumbnail && a.thumbnail) {
                    albumCache[idx].thumbnail = a.thumbnail;
                }
                if (!albumCache[idx].href && a.href) {
                    albumCache[idx].href = a.href;
                }
            } else {
                albumCache.push(a);
                titleIndex[a.title] = albumCache.length - 1;
            }
        });
    }

    /**
     * 改善点②続き: サムネURLが遅延ロード中の場合、
     * IntersectionObserver で実際に表示されたタイミングで再スキャンする。
     */
    function watchLazyThumbnails() {
        if (!('IntersectionObserver' in window)) return;

        const obs = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const container = entry.target.closest('.album-container');
                if (!container) return;
                const bgEl = container.querySelector('.bg-image');
                if (!bgEl) return;
                const style = bgEl.style.backgroundImage;
                if (!style || style === 'none') return;

                const url = style.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
                const titleEl = container.querySelector('h5.album-title');
                if (!titleEl) return;
                const title = titleEl.getAttribute('title') || titleEl.textContent.trim();

                const cached = albumCache.find(a => a.title === title);
                if (cached && !cached.thumbnail && url) {
                    cached.thumbnail = url;
                    // 表示中のカードも即時更新
                    const card = document.querySelector(`[data-album-title="${CSS.escape(title)}"] .at-album-thumb`);
                    if (card) card.style.backgroundImage = `url(${url})`;
                }

                obs.unobserve(entry.target);
            });
        }, { threshold: 0.1 });

        // .bg-image 要素を監視対象に追加
        document.querySelectorAll('.album-container').forEach(c => {
            const bg = c.querySelector('.bg-image');
            if (bg) obs.observe(bg);
        });
    }

    // =====================
    // AmazonのUIを隠す／戻す
    // =====================
    function hideAmazonUI() {
        const anyAlbum = document.querySelector('.album-container');
        if (anyAlbum) {
            let parent = anyAlbum.parentElement;
            for (let i = 0; i < 4; i++) {
                if (!parent || parent === document.body) break;
                if (!parent.dataset.atHidden) {
                    parent.dataset.atHidden = 'true';
                    parent.style.display = 'none';
                }
                parent = parent.parentElement;
            }
        }
        ['.photos-owned-nodes-view', '.personal-photos-albums-view'].forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (!el.dataset.atHidden) {
                    el.dataset.atHidden = 'true';
                    el.style.display = 'none';
                }
            });
        });
    }

    function showAmazonUI() {
        document.querySelectorAll('[data-at-hidden]').forEach(el => {
            el.style.display = '';
            delete el.dataset.atHidden;
        });
    }

    // =====================
    // UI構築（初回のみ）
    // =====================
    function buildUI() {
        if (document.getElementById('at-btn')) return;
        injectStyles();
        createModal();
        createExplorerContainer();
        createFAB();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #at-btn {
                position: fixed;
                bottom: 24px; left: 50%;
                transform: translateX(-50%);
                z-index: 99999;
                padding: 13px 22px;
                border-radius: 999px; border: none;
                background: #111; color: #fff;
                font-size: 15px; font-weight: bold;
                box-shadow: 0 4px 16px rgba(0,0,0,0.25);
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.2s;
            }
            #at-btn.active { background: #1a6ee6; }

            #at-explorer-container {
                display: none;
                width: 100%;
                min-height: 100vh;
                background: #fff;
                box-sizing: border-box;
                padding-bottom: 100px;
                position: relative;
                z-index: 100;
            }
            #at-explorer-container.active { display: block; }

            /* =====================
               改善点③: 戻るボタンを
               画面固定の大きなバーに変更
               ===================== */
            #at-explorer-header {
                position: sticky;
                top: 0;
                background: #fff;
                z-index: 10000;  /* Amazon UIより確実に前面 */
                padding: 12px 16px 10px;
                border-bottom: 1px solid #eee;
                /* iOSのSafe Area対応 */
                padding-top: max(12px, env(safe-area-inset-top));
            }

            #at-nav-row {
                display: flex;
                align-items: center;
                gap: 0;
                min-height: 36px;
                margin-bottom: 8px;
            }

            /* 戻るボタン: タップ領域を広くとる */
            #at-back-btn {
                display: none;
                align-items: center;
                gap: 2px;
                font-size: 17px;
                font-weight: 600;
                color: #1a6ee6;
                cursor: pointer;
                background: none;
                border: none;
                padding: 8px 12px 8px 0;
                /* タップ領域を広げる */
                min-width: 64px;
                min-height: 44px;
                -webkit-tap-highlight-color: transparent;
                flex-shrink: 0;
            }
            #at-back-btn.visible { display: flex; }
            #at-back-btn:active { opacity: 0.5; }

            #at-back-icon {
                font-size: 22px;
                line-height: 1;
                margin-top: -1px;
            }

            #at-breadcrumb {
                font-size: 19px;
                font-weight: bold;
                color: #111;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 1;
            }

            /* パンくずリスト: 現在階層を視覚的に示す */
            #at-breadcrumb-path {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 4px;
                margin-bottom: 6px;
                min-height: 20px;
            }
            .at-crumb {
                font-size: 12px;
                color: #1a6ee6;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 999px;
                background: #eef4ff;
                white-space: nowrap;
                -webkit-tap-highlight-color: transparent;
            }
            .at-crumb:active { background: #d8e9ff; }
            .at-crumb-sep {
                font-size: 12px;
                color: #bbb;
            }
            .at-crumb-current {
                font-size: 12px;
                color: #555;
                white-space: nowrap;
            }

            #at-search {
                display: block;
                width: 100%;
                padding: 10px 14px;
                font-size: 16px;
                border: 1.5px solid #e0e0e0;
                border-radius: 12px;
                outline: none;
                box-sizing: border-box;
                /* iOSでズームしないように */
                font-size: max(16px, 1rem);
            }
            #at-search:focus { border-color: #888; }

            /* アルバム数バッジ */
            #at-count-label {
                font-size: 12px;
                color: #aaa;
                margin: 8px 16px 0;
            }

            #at-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 14px;
                padding: 16px;
            }

            .at-folder-card {
                background: #f5f5f5;
                border-radius: 16px;
                padding: 20px 12px;
                aspect-ratio: 1;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
                position: relative;
            }
            .at-folder-card:active { background: #ebebeb; }
            .at-folder-icon { font-size: 44px; margin-bottom: 10px; line-height: 1; }
            .at-folder-name {
                text-align: center;
                font-size: 14px;
                font-weight: bold;
                color: #222;
                word-break: break-word;
                line-height: 1.35;
            }
            /* フォルダ内アルバム数バッジ */
            .at-folder-badge {
                position: absolute;
                top: 10px; right: 12px;
                background: #ddd;
                color: #666;
                font-size: 11px;
                font-weight: bold;
                border-radius: 999px;
                padding: 2px 7px;
            }

            .at-album-card {
                border-radius: 16px;
                overflow: hidden;
                background: #fff;
                box-shadow: 0 2px 10px rgba(0,0,0,0.09);
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            .at-album-card:active { opacity: 0.85; }
            .at-album-thumb {
                width: 100%;
                aspect-ratio: 1;
                background-size: cover;
                background-position: center;
                background-color: #e8e8e8;
                /* 改善点②: 画像フェードイン */
                transition: background-image 0.3s ease;
            }
            /* サムネ読み込み中スケルトン */
            .at-album-thumb.loading {
                background: linear-gradient(90deg, #ececec 25%, #f5f5f5 50%, #ececec 75%);
                background-size: 200% 100%;
                animation: at-skeleton 1.2s infinite;
            }
            @keyframes at-skeleton {
                0% { background-position: 200% 0; }
                100% { background-position: -200% 0; }
            }
            .at-album-title-label {
                padding: 8px 10px 10px;
                font-size: 13px;
                font-weight: bold;
                color: #222;
                line-height: 1.4;
                word-break: break-word;
            }

            .at-section-label {
                grid-column: 1 / -1;
                padding: 8px 4px 4px;
                font-size: 12px;
                color: #aaa;
                letter-spacing: 0.05em;
                text-transform: uppercase;
            }

            /* 空状態 */
            #at-empty {
                display: none;
                grid-column: 1 / -1;
                text-align: center;
                padding: 60px 20px;
                color: #bbb;
                font-size: 15px;
            }

            /* フォルダ設定モーダル */
            #at-modal-overlay {
                display: none;
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.4);
                z-index: 999998;
            }
            #at-modal-overlay.open { display: block; }

            #at-modal {
                position: fixed; left: 0; bottom: 0;
                width: 100%; background: #fff;
                border-radius: 20px 20px 0 0;
                z-index: 999999;
                padding: 20px 20px 40px;
                padding-bottom: max(40px, env(safe-area-inset-bottom));
                box-shadow: 0 -4px 24px rgba(0,0,0,0.2);
                box-sizing: border-box;
                transform: translateY(100%);
                transition: transform 0.3s cubic-bezier(.4,0,.2,1);
            }
            #at-modal.open { transform: translateY(0); }

            #at-modal-title { font-size: 17px; font-weight: bold; margin-bottom: 6px; color: #111; }
            #at-modal-album { font-size: 14px; color: #888; margin-bottom: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #at-folder-input {
                width: 100%; padding: 13px 14px;
                font-size: max(16px, 1rem); /* iOSズーム防止 */
                border: 1.5px solid #e0e0e0; border-radius: 12px;
                box-sizing: border-box; outline: none;
            }
            #at-folder-input:focus { border-color: #555; }
            #at-folder-hint { font-size: 12px; color: #bbb; margin: 6px 4px 16px; }
            #at-modal-actions { display: flex; gap: 10px; }
            .at-modal-btn {
                flex: 1; padding: 14px;
                border: none; border-radius: 12px;
                font-size: 16px; font-weight: bold; cursor: pointer;
                min-height: 50px;
            }
            #at-save-btn { background: #111; color: #fff; }
            #at-clear-btn { background: #f0f0f0; color: #555; }
        `;
        document.head.appendChild(style);
    }

    function createFAB() {
        const btn = document.createElement('button');
        btn.id = 'at-btn';
        btn.textContent = '📁 AlbumTree';
        btn.onclick = toggleExplorer;
        document.body.appendChild(btn);
    }

    function createExplorerContainer() {
        if (document.getElementById('at-explorer-container')) return;

        const container = document.createElement('div');
        container.id = 'at-explorer-container';

        // ヘッダー
        const header = document.createElement('div');
        header.id = 'at-explorer-header';

        // ナビ行（戻るボタン + タイトル）
        const navRow = document.createElement('div');
        navRow.id = 'at-nav-row';

        const backBtn = document.createElement('button');
        backBtn.id = 'at-back-btn';
        backBtn.innerHTML = '<span id="at-back-icon">‹</span> 戻る';
        backBtn.setAttribute('aria-label', '前の階層へ戻る');
        backBtn.onclick = navigateBack;
        navRow.appendChild(backBtn);

        const breadcrumb = document.createElement('div');
        breadcrumb.id = 'at-breadcrumb';
        navRow.appendChild(breadcrumb);
        header.appendChild(navRow);

        // パンくずリスト（クリックで任意の階層へジャンプ）
        const breadcrumbPath = document.createElement('div');
        breadcrumbPath.id = 'at-breadcrumb-path';
        header.appendChild(breadcrumbPath);

        const search = document.createElement('input');
        search.id = 'at-search';
        search.type = 'search';
        search.placeholder = '🔍 アルバムを検索';
        search.addEventListener('input', () => filterExplorer(search.value));
        header.appendChild(search);

        container.appendChild(header);

        const countLabel = document.createElement('div');
        countLabel.id = 'at-count-label';
        container.appendChild(countLabel);

        const grid = document.createElement('div');
        grid.id = 'at-grid';

        const empty = document.createElement('div');
        empty.id = 'at-empty';
        empty.textContent = 'アルバムがありません';
        grid.appendChild(empty);

        container.appendChild(grid);

        const insertTarget =
            document.querySelector('.photos-client-container') ||
            document.querySelector('main') ||
            document.body;
        insertTarget.prepend(container);
    }

    function createModal() {
        const overlay = document.createElement('div');
        overlay.id = 'at-modal-overlay';
        overlay.onclick = closeModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'at-modal';
        modal.innerHTML = `
            <div id="at-modal-title">📁 フォルダ設定</div>
            <div id="at-modal-album"></div>
            <input id="at-folder-input" placeholder="例: ライブ｜2025｜05" autocomplete="off" />
            <div id="at-folder-hint">｜で区切って階層を指定（例: 旅行｜2024｜夏）</div>
            <div id="at-modal-actions">
                <button class="at-modal-btn" id="at-clear-btn">クリア</button>
                <button class="at-modal-btn" id="at-save-btn">保存</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('at-save-btn').onclick = saveFolder;
        document.getElementById('at-clear-btn').onclick = clearFolder;
    }

    // =====================
    // エクスプローラー開閉
    // =====================
    function toggleExplorer() {
        if (explorerActive) {
            deactivateExplorer();
        } else {
            activateExplorer();
        }
    }

    function activateExplorer() {
        explorerActive = true;
        currentPath = [];
        hideAmazonUI();
        document.getElementById('at-explorer-container').classList.add('active');
        document.getElementById('at-btn').classList.add('active');
        document.getElementById('at-btn').textContent = '✕ 閉じる';

        // 改善点①: エクスプローラーを開いたタイミングでDOMを再スキャン
        const fresh = scanAlbumsFromDOM();
        mergeIntoCache(fresh);
        watchLazyThumbnails();
        renderExplorer();
    }

    function deactivateExplorer() {
        explorerActive = false;
        document.getElementById('at-explorer-container').classList.remove('active');
        document.getElementById('at-btn').classList.remove('active');
        document.getElementById('at-btn').textContent = '📁 AlbumTree';
        showAmazonUI();
    }

    // =====================
    // ナビゲーション
    // =====================

    /**
     * 改善点③: 戻る操作を一か所に集約し、
     * パンくずクリックでも任意の階層へジャンプできるようにする。
     */
    function navigateBack() {
        if (currentPath.length === 0) return;
        currentPath.pop();
        renderExplorer();
        // ページ最上部へスクロール（ヘッダーが見える位置に戻す）
        document.getElementById('at-explorer-container').scrollTop = 0;
        window.scrollTo({ top: 0, behavior: 'instant' });
    }

    function navigateTo(depth) {
        currentPath = currentPath.slice(0, depth);
        renderExplorer();
        window.scrollTo({ top: 0, behavior: 'instant' });
    }

    // =====================
    // モーダル
    // =====================
    function openModal(albumName) {
        currentAlbumName = albumName;
        const folderMap = loadFolderMap();
        document.getElementById('at-modal-album').textContent = albumName;
        document.getElementById('at-folder-input').value = folderMap[albumName] || '';
        document.getElementById('at-modal').classList.add('open');
        document.getElementById('at-modal-overlay').classList.add('open');
        setTimeout(() => document.getElementById('at-folder-input').focus(), 100);
    }

    function closeModal() {
        document.getElementById('at-modal').classList.remove('open');
        document.getElementById('at-modal-overlay').classList.remove('open');
    }

    function saveFolder() {
        const path = document.getElementById('at-folder-input').value.trim();
        const folderMap = loadFolderMap();
        if (path) {
            folderMap[currentAlbumName] = path;
        } else {
            delete folderMap[currentAlbumName];
        }
        saveFolderMap(folderMap);
        closeModal();
        renderExplorer();
    }

    function clearFolder() {
        const folderMap = loadFolderMap();
        delete folderMap[currentAlbumName];
        saveFolderMap(folderMap);
        document.getElementById('at-folder-input').value = '';
        closeModal();
        renderExplorer();
    }

    // =====================
    // エクスプローラー描画
    // =====================
    function renderExplorer() {
        const grid = document.getElementById('at-grid');
        const breadcrumb = document.getElementById('at-breadcrumb');
        const breadcrumbPath = document.getElementById('at-breadcrumb-path');
        const backBtn = document.getElementById('at-back-btn');
        const countLabel = document.getElementById('at-count-label');
        const search = document.getElementById('at-search');
        if (!grid) return;

        // タイトル
        breadcrumb.textContent = currentPath.length
            ? currentPath[currentPath.length - 1]
            : 'AlbumTree';

        // 改善点③: 戻るボタン表示
        backBtn.classList.toggle('visible', currentPath.length > 0);

        // パンくずリスト生成（ルート > フォルダA > フォルダB）
        breadcrumbPath.innerHTML = '';
        if (currentPath.length > 0) {
            // ルートへのリンク
            const rootCrumb = document.createElement('span');
            rootCrumb.className = 'at-crumb';
            rootCrumb.textContent = 'AlbumTree';
            rootCrumb.onclick = () => navigateTo(0);
            breadcrumbPath.appendChild(rootCrumb);

            currentPath.forEach((p, i) => {
                const sep = document.createElement('span');
                sep.className = 'at-crumb-sep';
                sep.textContent = '›';
                breadcrumbPath.appendChild(sep);

                if (i < currentPath.length - 1) {
                    const crumb = document.createElement('span');
                    crumb.className = 'at-crumb';
                    crumb.textContent = p;
                    crumb.onclick = () => navigateTo(i + 1);
                    breadcrumbPath.appendChild(crumb);
                } else {
                    const cur = document.createElement('span');
                    cur.className = 'at-crumb-current';
                    cur.textContent = p;
                    breadcrumbPath.appendChild(cur);
                }
            });
        }

        if (search) search.value = '';

        const folderMap = loadFolderMap();

        // フォルダとアルバムを仕分け
        const folderAlbumCount = {};  // フォルダ名 → 直下・配下アルバム数
        const visibleAlbums = [];
        const unassignedAlbums = [];

        albumCache.forEach(album => {
            const path = folderMap[album.title] || '';
            const parts = path.split('｜').filter(Boolean);

            const isCurrent = currentPath.every((p, i) => parts[i] === p);
            if (!isCurrent) return;

            if (parts.length > currentPath.length) {
                const folderName = parts[currentPath.length];
                folderAlbumCount[folderName] = (folderAlbumCount[folderName] || 0) + 1;
            } else if (parts.length === currentPath.length && path) {
                visibleAlbums.push(album);
            } else if (!path && currentPath.length === 0) {
                unassignedAlbums.push(album);
            }
        });

        // グリッドを再構築（空状態要素は残す）
        grid.innerHTML = '';
        const emptyEl = document.createElement('div');
        emptyEl.id = 'at-empty';
        emptyEl.textContent = 'アルバムがありません';
        grid.appendChild(emptyEl);

        const folders = Object.keys(folderAlbumCount).sort();
        const totalVisible = folders.length + visibleAlbums.length + unassignedAlbums.length;

        // カウント表示
        if (countLabel) {
            if (totalVisible > 0) {
                const parts = [];
                if (folders.length) parts.push(`フォルダ ${folders.length}`);
                if (visibleAlbums.length) parts.push(`アルバム ${visibleAlbums.length}`);
                if (unassignedAlbums.length) parts.push(`未分類 ${unassignedAlbums.length}`);
                countLabel.textContent = parts.join('　');
            } else {
                countLabel.textContent = '';
            }
        }

        emptyEl.style.display = totalVisible === 0 ? 'block' : 'none';

        // フォルダカード
        folders.forEach(folder => {
            const card = document.createElement('div');
            card.className = 'at-folder-card';

            const badge = document.createElement('span');
            badge.className = 'at-folder-badge';
            badge.textContent = folderAlbumCount[folder];
            card.appendChild(badge);

            const icon = document.createElement('div');
            icon.className = 'at-folder-icon';
            icon.textContent = '📁';
            card.appendChild(icon);

            const name = document.createElement('div');
            name.className = 'at-folder-name';
            name.textContent = folder;
            card.appendChild(name);

            card.onclick = () => {
                currentPath.push(folder);
                renderExplorer();
                window.scrollTo({ top: 0, behavior: 'instant' });
            };
            grid.appendChild(card);
        });

        // アルバムカード（フォルダ割り当て済み）
        if (visibleAlbums.length > 0 && folders.length > 0) {
            const label = document.createElement('div');
            label.className = 'at-section-label';
            label.textContent = 'アルバム';
            grid.appendChild(label);
        }
        visibleAlbums.sort((a, b) => a.title.localeCompare(b.title, 'ja')).forEach(album => {
            grid.appendChild(makeAlbumCard(album));
        });

        // 未分類アルバム（ルートのみ）
        if (currentPath.length === 0 && unassignedAlbums.length > 0) {
            const label = document.createElement('div');
            label.className = 'at-section-label';
            label.textContent = '未分類';
            grid.appendChild(label);

            unassignedAlbums.sort((a, b) => a.title.localeCompare(b.title, 'ja')).forEach(album => {
                grid.appendChild(makeAlbumCard(album));
            });
        }
    }

    function makeAlbumCard(album) {
        const card = document.createElement('div');
        card.className = 'at-album-card';
        card.dataset.albumTitle = album.title;
        card.dataset.album = album.title.toLowerCase();

        const thumb = document.createElement('div');
        thumb.className = 'at-album-thumb';

        if (album.thumbnail) {
            // 改善点②: 画像を先にプリロードしてからカードに反映
            const img = new Image();
            img.onload = () => {
                thumb.style.backgroundImage = `url(${album.thumbnail})`;
                thumb.classList.remove('loading');
            };
            img.onerror = () => {
                thumb.classList.remove('loading');
            };
            thumb.classList.add('loading');
            img.src = album.thumbnail;
        } else {
            thumb.classList.add('loading');
        }
        card.appendChild(thumb);

        const title = document.createElement('div');
        title.className = 'at-album-title-label';
        title.textContent = album.title;
        card.appendChild(title);

        // タップでアルバムを開く
        card.onclick = () => {
            if (album.href) window.location.href = album.href;
        };

        // 長押しでフォルダ設定（モバイル）
        let pressTimer;
        let didLongPress = false;
        card.addEventListener('touchstart', () => {
            didLongPress = false;
            pressTimer = setTimeout(() => {
                didLongPress = true;
                openModal(album.title);
            }, 600);
        });
        card.addEventListener('touchend', (e) => {
            clearTimeout(pressTimer);
            if (didLongPress) e.preventDefault(); // 長押し後のクリックをキャンセル
        });
        card.addEventListener('touchmove', () => {
            clearTimeout(pressTimer);
        });

        // 右クリックでフォルダ設定（PC）
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openModal(album.title);
        });

        return card;
    }

    // =====================
    // 検索フィルター
    // =====================
    function filterExplorer(keyword) {
        const kw = keyword.toLowerCase().trim();
        document.querySelectorAll('#at-grid .at-album-card').forEach(card => {
            card.style.display = (!kw || card.dataset.album.includes(kw)) ? '' : 'none';
        });
        // 検索中はフォルダ・セクションラベルを隠す
        document.querySelectorAll('#at-grid .at-folder-card, #at-grid .at-section-label').forEach(el => {
            el.style.display = kw ? 'none' : '';
        });
        // 空状態チェック
        const emptyEl = document.getElementById('at-empty');
        if (emptyEl && kw) {
            const anyVisible = [...document.querySelectorAll('#at-grid .at-album-card')]
                .some(c => c.style.display !== 'none');
            emptyEl.style.display = anyVisible ? 'none' : 'block';
        }
    }

    // =====================
    // 初期化
    // =====================
    function init() {
        buildUI();
        startAlbumObserver(); // setInterval の代わりに MutationObserver を使う
    }

    // DOMContentLoaded 後か、既にロード済みなら即実行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Amazon Photos は SPA なのでURLが変わったときに再初期化
    let lastHref = location.href;
    setInterval(() => {
        if (location.href !== lastHref) {
            lastHref = location.href;
            // エクスプローラーが開いていれば閉じる
            if (explorerActive) deactivateExplorer();
            // UIが消えていたら再構築
            setTimeout(init, 500);
        }
    }, 1000);

})();
