// ==UserScript==
// @name         Amazon Photos AlbumTree
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Amazon Photos アルバムを階層フォルダで管理 (iPhone向け)
// @match        https://www.amazon.co.jp/photos/*
// @match        https://www.amazon.com/photos/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'amazon-photo-folder-map';
    let currentAlbumName = null;

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
    // ツリー構築
    // =====================
    function buildTree() {
        const folderMap = loadFolderMap();
        const tree = {};

        // フォルダに入っていないアルバムも表示
        const albums = getAlbumNames();
        albums.forEach(album => {
            if (!folderMap[album]) {
                if (!tree['__unassigned']) tree['__unassigned'] = {};
                if (!tree['__unassigned'].__albums) tree['__unassigned'].__albums = [];
                tree['__unassigned'].__albums.push(album);
            }
        });

        Object.entries(folderMap).forEach(([album, path]) => {
            if (!path) return;
            const parts = path.split('｜').map(p => p.trim()).filter(Boolean);
            let current = tree;
            parts.forEach(part => {
                if (!current[part]) current[part] = {};
                current = current[part];
            });
            if (!current.__albums) current.__albums = [];
            current.__albums.push(album);
        });

        return tree;
    }

    function getAlbumNames() {
        return [...document.querySelectorAll('h5.album-title')]
            .map(el => el.getAttribute('title'))
            .filter(Boolean);
    }

    // =====================
    // UI構築（初回のみ）
    // =====================
    function buildUI() {
        if (document.getElementById('at-btn')) return;

        injectStyles();
        createOverlay();
        createDrawer();
        createModal();
        createFAB();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #at-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.4);
                z-index: 999990;
                opacity: 0; pointer-events: none;
                transition: opacity 0.3s;
            }
            #at-overlay.open { opacity: 1; pointer-events: auto; }

            #at-drawer {
                position: fixed; left: 0; bottom: 0;
                width: 100%; height: 72vh;
                background: #fff;
                border-radius: 20px 20px 0 0;
                z-index: 999995;
                display: flex; flex-direction: column;
                box-shadow: 0 -4px 24px rgba(0,0,0,0.18);
                transform: translateY(100%);
                transition: transform 0.32s cubic-bezier(.4,0,.2,1);
            }
            #at-drawer.open { transform: translateY(0); }

            #at-handle {
                width: 44px; height: 5px;
                background: #d0d0d0; border-radius: 99px;
                margin: 12px auto 0;
                flex-shrink: 0;
            }

            #at-search {
                margin: 10px 16px 8px;
                padding: 11px 14px;
                font-size: 16px;
                border: 1.5px solid #e0e0e0;
                border-radius: 12px;
                outline: none;
                flex-shrink: 0;
            }
            #at-search:focus { border-color: #888; }

            #at-content {
                flex: 1; overflow-y: auto;
                padding: 4px 16px 48px;
            }

            .at-folder-row {
                display: flex; align-items: center; gap: 6px;
                padding: 10px 4px;
                font-size: 16px; font-weight: bold;
                cursor: pointer;
                color: #222;
                border-bottom: 1px solid #f0f0f0;
            }
            .at-folder-row .at-toggle {
                font-size: 11px;
                color: #999;
                width: 14px;
                transition: transform 0.2s;
            }
            .at-folder-row.closed .at-toggle { transform: rotate(-90deg); }

            .at-album-row {
                display: flex; align-items: center; justify-content: space-between;
                padding: 9px 4px;
                font-size: 15px;
                color: #444;
                border-bottom: 1px solid #f5f5f5;
                cursor: pointer;
            }
            .at-album-row:hover { background: #f9f9f9; border-radius: 8px; }
            .at-album-row .at-album-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .at-album-row .at-edit-btn {
                flex-shrink: 0;
                background: none; border: none;
                font-size: 18px; cursor: pointer;
                padding: 2px 6px;
                opacity: 0.5;
                border-radius: 6px;
            }
            .at-album-row .at-edit-btn:active { background: #eee; opacity: 1; }

            .at-unassigned-label {
                font-size: 12px; color: #aaa;
                padding: 12px 4px 4px;
                letter-spacing: 0.04em;
                text-transform: uppercase;
            }

            #at-modal {
                position: fixed; left: 0; bottom: 0;
                width: 100%; background: #fff;
                border-radius: 20px 20px 0 0;
                z-index: 999999;
                padding: 20px 20px 36px;
                box-shadow: 0 -4px 24px rgba(0,0,0,0.2);
                box-sizing: border-box;
                transform: translateY(100%);
                transition: transform 0.3s cubic-bezier(.4,0,.2,1);
            }
            #at-modal.open { transform: translateY(0); }

            #at-modal-title {
                font-size: 17px; font-weight: bold;
                margin-bottom: 6px; color: #111;
            }
            #at-modal-album {
                font-size: 14px; color: #888;
                margin-bottom: 14px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            #at-folder-input {
                width: 100%; padding: 13px 14px;
                font-size: 16px;
                border: 1.5px solid #e0e0e0; border-radius: 12px;
                box-sizing: border-box; outline: none;
            }
            #at-folder-input:focus { border-color: #555; }
            #at-folder-hint {
                font-size: 12px; color: #bbb;
                margin: 6px 4px 16px;
            }
            #at-modal-actions {
                display: flex; gap: 10px;
            }
            .at-modal-btn {
                flex: 1; padding: 14px;
                border: none; border-radius: 12px;
                font-size: 16px; font-weight: bold;
                cursor: pointer;
            }
            #at-save-btn { background: #111; color: #fff; }
            #at-clear-btn { background: #f0f0f0; color: #555; }

            #at-btn {
                position: fixed;
                bottom: 24px; left: 50%;
                transform: translateX(-50%);
                z-index: 999989;
                padding: 13px 22px;
                border-radius: 999px; border: none;
                background: #111; color: #fff;
                font-size: 15px; font-weight: bold;
                box-shadow: 0 4px 16px rgba(0,0,0,0.25);
                cursor: pointer;
                white-space: nowrap;
            }

            /* アルバムタイトル横のフォルダボタン */
            .at-inline-btn {
                display: inline-flex; align-items: center; justify-content: center;
                width: 26px; height: 26px;
                border: none; background: none;
                font-size: 17px; cursor: pointer;
                vertical-align: middle;
                margin-left: 4px;
                border-radius: 6px;
                position: relative;
                z-index: 100;
            }
            .at-inline-btn.assigned { color: #f5a623; }
            .at-inline-btn:not(.assigned) { color: #bbb; }
        `;
        document.head.appendChild(style);
    }

    function createOverlay() {
        const el = document.createElement('div');
        el.id = 'at-overlay';
        el.onclick = closeAll;
        document.body.appendChild(el);
    }

    function createFAB() {
        const btn = document.createElement('button');
        btn.id = 'at-btn';
        btn.textContent = '📁 AlbumTree';
        btn.onclick = toggleDrawer;
        document.body.appendChild(btn);
    }

    function createDrawer() {
        const drawer = document.createElement('div');
        drawer.id = 'at-drawer';

        const handle = document.createElement('div');
        handle.id = 'at-handle';
        drawer.appendChild(handle);

        const search = document.createElement('input');
        search.id = 'at-search';
        search.placeholder = '🔍 アルバムを検索';
        search.addEventListener('input', () => filterTree(search.value));
        drawer.appendChild(search);

        const content = document.createElement('div');
        content.id = 'at-content';
        drawer.appendChild(content);

        document.body.appendChild(drawer);
    }

    function createModal() {
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
    // ドロワー開閉
    // =====================
    function toggleDrawer() {
        const drawer = document.getElementById('at-drawer');
        const isOpen = drawer.classList.contains('open');
        if (isOpen) {
            closeAll();
        } else {
            openDrawer();
        }
    }

    function openDrawer() {
        updateTree();
        document.getElementById('at-drawer').classList.add('open');
        document.getElementById('at-overlay').classList.add('open');
    }

    function closeAll() {
        document.getElementById('at-drawer')?.classList.remove('open');
        document.getElementById('at-modal')?.classList.remove('open');
        document.getElementById('at-overlay')?.classList.remove('open');
    }

    function openModal(albumName) {
        currentAlbumName = albumName;
        const folderMap = loadFolderMap();
        document.getElementById('at-modal-album').textContent = albumName;
        document.getElementById('at-folder-input').value = folderMap[albumName] || '';
        document.getElementById('at-modal').classList.add('open');
        setTimeout(() => document.getElementById('at-folder-input').focus(), 100);
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
        updateInlineButtons();
        updateTree();
        document.getElementById('at-modal').classList.remove('open');
    }

    function clearFolder() {
        const folderMap = loadFolderMap();
        delete folderMap[currentAlbumName];
        saveFolderMap(folderMap);
        document.getElementById('at-folder-input').value = '';
        updateInlineButtons();
        updateTree();
        document.getElementById('at-modal').classList.remove('open');
    }

    // =====================
    // ツリー描画
    // =====================
    function updateTree() {
        const content = document.getElementById('at-content');
        if (!content) return;
        content.innerHTML = '';
        const tree = buildTree();
        renderTree(tree, content, 0);
    }

    function renderTree(tree, parent, depth) {
        const sortedKeys = Object.keys(tree).filter(k => k !== '__albums' && k !== '__unassigned').sort();

        sortedKeys.forEach(key => {
            const node = tree[key];

            // フォルダ行
            const folderRow = document.createElement('div');
            folderRow.className = 'at-folder-row';
            folderRow.style.paddingLeft = `${depth * 18 + 4}px`;

            const toggle = document.createElement('span');
            toggle.className = 'at-toggle';
            toggle.textContent = '▼';
            folderRow.appendChild(toggle);

            const folderIcon = document.createElement('span');
            folderIcon.textContent = '📁';
            folderRow.appendChild(folderIcon);

            const label = document.createElement('span');
            label.textContent = key;
            folderRow.appendChild(label);

            parent.appendChild(folderRow);

            // 子コンテナ
            const childContainer = document.createElement('div');
            parent.appendChild(childContainer);

            renderTree(node, childContainer, depth + 1);

            // アルバム
            if (node.__albums) {
                node.__albums.sort().forEach(album => {
                    childContainer.appendChild(makeAlbumRow(album, depth + 1));
                });
            }

            // 折りたたみ
            let open = true;
            folderRow.onclick = () => {
                open = !open;
                childContainer.style.display = open ? '' : 'none';
                toggle.textContent = open ? '▼' : '▶';
                folderRow.classList.toggle('closed', !open);
            };
        });

        // 未割り当てアルバム
        if (tree.__unassigned?.__albums?.length) {
            const label = document.createElement('div');
            label.className = 'at-unassigned-label';
            label.textContent = '未分類';
            parent.appendChild(label);
            tree.__unassigned.__albums.sort().forEach(album => {
                parent.appendChild(makeAlbumRow(album, 0));
            });
        }
    }

    function makeAlbumRow(albumName, depth) {
        const row = document.createElement('div');
        row.className = 'at-album-row';
        row.dataset.album = albumName.toLowerCase();
        row.style.paddingLeft = `${depth * 18 + 4}px`;

        const nameEl = document.createElement('span');
        nameEl.className = 'at-album-name';
        nameEl.textContent = '🖼 ' + albumName;
        row.appendChild(nameEl);

        const editBtn = document.createElement('button');
        editBtn.className = 'at-edit-btn';
        editBtn.textContent = '📁';
        editBtn.title = 'フォルダ設定';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            openModal(albumName);
        };
        row.appendChild(editBtn);

        // アルバムページへ移動
        row.onclick = () => {
            const link = findAlbumLink(albumName);
            if (link) link.click();
            else closeAll();
        };

        return row;
    }

    function findAlbumLink(albumName) {
        const titles = document.querySelectorAll('h5.album-title');
        for (const t of titles) {
            if (t.getAttribute('title') === albumName) {
                return t.closest('a') || t.closest('[role="link"]') || t.closest('[data-testid]');
            }
        }
        return null;
    }

    // =====================
    // 検索フィルター
    // =====================
    function filterTree(keyword) {
        const kw = keyword.toLowerCase().trim();
        const rows = document.querySelectorAll('#at-content .at-album-row');
        rows.forEach(row => {
            const match = !kw || row.dataset.album.includes(kw);
            row.style.display = match ? '' : 'none';
        });
    }

    // =====================
    // アルバムタイトル横のボタン
    // =====================
    function addInlineButtons() {
        const folderMap = loadFolderMap();
        document.querySelectorAll('h5.album-title').forEach(el => {
            if (el.dataset.atEnhanced) return;
            el.dataset.atEnhanced = 'true';

            const albumName = el.getAttribute('title');

            const btn = document.createElement('button');
            btn.className = 'at-inline-btn' + (folderMap[albumName] ? ' assigned' : '');
            btn.textContent = '📁';
            btn.title = folderMap[albumName] ? `フォルダ: ${folderMap[albumName]}` : 'フォルダを設定';

            // ✅ 重要: クリックのバブリングとデフォルト動作を両方止める
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                openModal(albumName);
                buildUI(); // ドロワーがまだなければ生成
                document.getElementById('at-overlay').classList.add('open');
            }, true); // キャプチャフェーズで捕捉

            // h5の直後、または親のリンク要素の外に挿入
            const parentLink = el.closest('a');
            if (parentLink && parentLink.parentElement) {
                // リンクの外側（兄弟要素）として追加
                const wrapper = document.createElement('span');
                wrapper.style.cssText = 'display:inline-block;vertical-align:middle;';
                wrapper.appendChild(btn);
                parentLink.parentElement.insertBefore(wrapper, parentLink.nextSibling);
            } else {
                el.appendChild(btn);
            }
        });
    }

    function updateInlineButtons() {
        const folderMap = loadFolderMap();
        document.querySelectorAll('.at-inline-btn').forEach(btn => {
            // ボタンに紐づくアルバム名を取得（親のh5から）
            const h5 = btn.closest('[data-at-enhanced]') ||
                document.querySelector(`h5[data-at-enhanced]`);
            // 簡易的に全ボタンを再評価
        });
        // 割り当て済みのラベルを更新
        document.querySelectorAll('h5.album-title').forEach(el => {
            const albumName = el.getAttribute('title');
            const wrapper = el.nextSibling;
            if (wrapper?.querySelector('.at-inline-btn')) {
                const btn = wrapper.querySelector('.at-inline-btn');
                btn.classList.toggle('assigned', !!folderMap[albumName]);
                btn.title = folderMap[albumName] ? `フォルダ: ${folderMap[albumName]}` : 'フォルダを設定';
            }
        });
    }

    // =====================
    // 初期化ループ
    // =====================
    function init() {
        buildUI();
        addInlineButtons();
    }

    setInterval(init, 2500);

})();
