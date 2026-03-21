(function () {
    'use strict';

    // --- 配置与全局变量 ---
    const BASE_DELAY = 600;
    const JITTER = 400;
    const PAGE_LIMIT = 100;
    const PROJECT_SIDEBAR_PREVIEW = 5;
    let accessToken = null;
    let capturedWorkspaceIds = new Set(); // 使用Set存储网络拦截到的ID，确保唯一性

    // --- 核心：网络拦截与信息捕获 ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = async function (resource, options) {
            tryCaptureToken(options?.headers);
            if (options?.headers?.['ChatGPT-Account-Id']) {
                const id = options.headers['ChatGPT-Account-Id'];
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            }
            return rawFetch.apply(this, arguments);
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        tryCaptureToken(this.getRequestHeader('Authorization'));
                        const id = this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            console.log('🎯 [XHR] 捕获到 Workspace ID:', id);
                            capturedWorkspaceIds.add(id);
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(header) {
        if (!header) return;
        const h = typeof header === 'string' ? header : header instanceof Headers ? header.get('Authorization') : header.Authorization || header.authorization;
        if (h?.startsWith('Bearer ')) {
        const token = h.slice(7);
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();
    const normalizeEpochSeconds = (value) => {
        if (!value) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? Math.floor(value / 1000) : value;
        }
        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        return 0;
    };
    const formatTimestamp = (value) => {
        const seconds = normalizeEpochSeconds(value);
        if (!seconds) return '';
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const parseDateInputToEpoch = (value, isEnd = false) => {
        if (!value) return null;
        const parts = value.split('-').map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
        const [year, month, day] = parts;
        const date = isEnd
            ? new Date(year, month - 1, day, 23, 59, 59, 999)
            : new Date(year, month - 1, day, 0, 0, 0, 0);
        const epochMs = date.getTime();
        return Number.isNaN(epochMs) ? null : Math.floor(epochMs / 1000);
    };

    function getModeLabel(mode) {
        if (mode === 'team') return '团队空间（项目外 + 项目内）';
        if (mode === 'project') return '项目对话（仅项目内）';
        return '个人空间（仅项目外）';
    }

    /**
     * [新增] 从Cookie中获取 oai-device-id
     * @returns {string|null} - 返回设备ID或null
     */
    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function generateUniqueFilename(convData) {
        const convId = convData.conversation_id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || Date.now().toString(36));
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}.json`;
    }

    function generateMarkdownFilename(convData) {
        const jsonName = generateUniqueFilename(convData);
        return jsonName.endsWith('.json')
            ? `${jsonName.slice(0, -5)}.md`
            : `${jsonName}.md`;
    }

    function cleanMessageContent(text) {
        if (!text) return '';
        return text
            .replace(/\uE200cite(?:\uE202turn\d+(?:search|view)\d+)+\uE201/gi, '')
            .replace(/cite(?:turn\d+(?:search|view)\d+)+/gi, '')
            .trim();
    }

    function processContentReferences(text, contentReferences) {
        if (!text || !Array.isArray(contentReferences) || contentReferences.length === 0) {
            return { text, footnotes: [] };
        }

        const references = contentReferences.filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text.length > 0);
        if (references.length === 0) {
            return { text, footnotes: [] };
        }

        const getReferenceInfo = (ref) => {
            const item = Array.isArray(ref.items) ? ref.items[0] : null;
            const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
            const title = item?.title || '';
            let label = item?.attribution || '';
            if (!label && typeof ref.alt === 'string') {
                const match = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
                if (match) label = match[1];
            }
            if (!label) label = title || url;
            return { url, title, label };
        };

        const footnotes = [];
        const footnoteIndexByKey = new Map();
        const citationRefs = references
            .filter(ref => ref.type === 'grouped_webpages')
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : Number.MAX_SAFE_INTEGER;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : Number.MAX_SAFE_INTEGER;
                return aIdx - bIdx;
            });

        citationRefs.forEach(ref => {
            const info = getReferenceInfo(ref);
            if (!info.url) return;
            const key = `${info.url}|${info.title}`;
            if (footnoteIndexByKey.has(key)) return;
            const index = footnotes.length + 1;
            footnoteIndexByKey.set(key, index);
            footnotes.push({ index, url: info.url, title: info.title, label: info.label });
        });

        const sortedByReplacement = references
            .slice()
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : -1;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : -1;
                if (aIdx !== -1 || bIdx !== -1) {
                    return bIdx - aIdx;
                }
                return (b.matched_text?.length || 0) - (a.matched_text?.length || 0);
            });

        let output = text;
        sortedByReplacement.forEach(ref => {
            if (!ref?.matched_text || ref.type === 'sources_footnote') return;
            let replacement = '';
            if (ref.type === 'grouped_webpages') {
                const info = getReferenceInfo(ref);
                if (info.url) {
                    const key = `${info.url}|${info.title}`;
                    const index = footnoteIndexByKey.get(key);
                    replacement = index ? `([${info.label}][${index}])` : (ref.alt || '');
                } else {
                    replacement = ref.alt || '';
                }
            } else {
                replacement = ref.alt || '';
            }

            if (Number.isFinite(ref.start_idx) && Number.isFinite(ref.end_idx)) {
                if (output.slice(ref.start_idx, ref.end_idx) === ref.matched_text) {
                    output = output.slice(0, ref.start_idx) + replacement + output.slice(ref.end_idx);
                    return;
                }
            }
            output = output.split(ref.matched_text).join(replacement);
        });

        return { text: output, footnotes };
    }

    function extractConversationMessages(convData) {
        const mapping = convData?.mapping;
        if (!mapping) return [];

        const messages = [];
        const mappingKeys = Object.keys(mapping);
        const rootId = mapping['client-created-root']
            ? 'client-created-root'
            : mappingKeys.find(id => !mapping[id]?.parent) || mappingKeys[0];
        const visited = new Set();

        const traverse = (nodeId) => {
            if (!nodeId || visited.has(nodeId)) return;
            visited.add(nodeId);
            const node = mapping[nodeId];
            if (!node) return;

            const msg = node.message;
            if (msg) {
                const author = msg.author?.role;
                const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                    msg.metadata?.is_contextual_answers_system_message;
                if (author && author !== 'system' && !isHidden) {
                    const content = msg.content;
                    if (content?.content_type === 'text' && Array.isArray(content.parts)) {
                        const rawText = content.parts
                            .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                            .filter(Boolean)
                            .join('\n');
                        const contentReferences = msg.metadata?.content_references || [];
                        let processedText = rawText;
                        let footnotes = [];
                        if (Array.isArray(contentReferences) && contentReferences.length > 0) {
                            const processed = processContentReferences(rawText, contentReferences);
                            processedText = processed.text;
                            footnotes = processed.footnotes;
                        }
                        const cleaned = cleanMessageContent(processedText);
                        if (cleaned) {
                            messages.push({
                                role: author,
                                content: cleaned,
                                create_time: msg.create_time || null,
                                footnotes
                            });
                        }
                    }
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(childId => traverse(childId));
            }
        };

        if (rootId) {
            traverse(rootId);
        } else {
            mappingKeys.forEach(traverse);
        }

        return messages;
    }

    function convertConversationToMarkdown(convData) {
        const messages = extractConversationMessages(convData);
        if (messages.length === 0) {
            return '# Conversation\nNo visible user or assistant messages were exported.\n';
        }

        const mdLines = [];
        messages.forEach(msg => {
            const roleLabel = msg.role === 'user' ? '# User' : '# Assistant';
            mdLines.push(roleLabel);
            mdLines.push(msg.content);
            if (Array.isArray(msg.footnotes) && msg.footnotes.length > 0) {
                mdLines.push('');
                msg.footnotes
                    .slice()
                    .sort((a, b) => a.index - b.index)
                    .forEach(note => {
                        if (!note.url) return;
                        const title = note.title ? ` "${note.title}"` : '';
                        mdLines.push(`[${note.index}]: ${note.url}${title}`);
                    });
            }
            mdLines.push('');
        });

        return mdLines.join('\n').trim() + '\n';
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    function buildQaZipFilename(mode, workspaceId, convShortId, date) {
        const wsPart = workspaceId || 'unknown';
        if (mode === 'team') {
            return `chatgpt_team_qa_selected_${wsPart}_${convShortId}_${date}.zip`;
        }
        if (mode === 'project') {
            return `chatgpt_project_qa_selected_${convShortId}_${date}.zip`;
        }
        return `chatgpt_personal_qa_selected_${convShortId}_${date}.zip`;
    }

    function buildExportZipFilename(mode, workspaceId, selectionType, date) {
        if (selectionType === 'selected') {
            return mode === 'team'
                ? `chatgpt_team_selected_${workspaceId}_${date}.zip`
                : mode === 'project'
                    ? `chatgpt_project_selected_${date}.zip`
                    : `chatgpt_personal_selected_${date}.zip`;
        }
        return mode === 'team'
            ? `chatgpt_team_backup_${workspaceId}_${date}.zip`
            : mode === 'project'
                ? `chatgpt_project_backup_${date}.zip`
                : `chatgpt_personal_backup_${date}.zip`;
    }

    function normalizeZipFilenameInput(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const sanitized = sanitizeFilename(raw);
        if (!sanitized) return '';
        return /\.zip$/i.test(sanitized) ? sanitized : `${sanitized}.zip`;
    }

    function promptZipFilename(options = {}) {
        const {
            defaultFilename = 'chatgpt-export.zip',
            title = '设置压缩包名称'
        } = options;

        return new Promise(resolve => {
            const existing = document.getElementById('export-zip-name-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'export-zip-name-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99999',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
            });

            const dialog = document.createElement('div');
            Object.assign(dialog.style, {
                background: '#fff', padding: '24px', borderRadius: '12px',
                boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '520px',
                fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
            });

            dialog.innerHTML = `
                <h2 style="margin-top:0; margin-bottom: 12px; font-size: 18px;">${escapeHtml(title)}</h2>
                <div style="margin-bottom: 16px; color: #666; font-size: 13px; line-height: 1.6;">
                    即将下载 ZIP 文件。你可以自定义压缩包名称；若留空，则继续使用原来的默认命名逻辑。
                </div>
                <label for="zip-name-input" style="display: block; margin-bottom: 8px; font-weight: bold;">压缩包名称（可选）</label>
                <input id="zip-name-input" type="text" placeholder="例如：chatgpt-backup-2026-xx-xx"
                    style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #ccc; box-sizing: border-box;">
                <div style="margin-top: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; font-size: 12px; color: #666; line-height: 1.6;">
                    默认文件名：<code style="font-family: monospace; color: #111;">${escapeHtml(defaultFilename)}</code>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;">
                    <button id="zip-name-cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                    <button id="zip-name-confirm-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">确认导出</button>
                </div>
            `;

            const closeDialog = (result) => {
                try {
                    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                } catch (_) {}
                resolve(result);
            };

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const input = dialog.querySelector('#zip-name-input');
            const cancelBtn = dialog.querySelector('#zip-name-cancel-btn');
            const confirmBtn = dialog.querySelector('#zip-name-confirm-btn');

            const handleConfirm = () => {
                const rawValue = input.value.trim();
                if (!rawValue) {
                    closeDialog(defaultFilename);
                    return;
                }
                const normalized = normalizeZipFilenameInput(rawValue);
                if (!normalized) {
                    alert('请输入有效的压缩包名称。');
                    input.focus();
                    return;
                }
                closeDialog(normalized);
            };

            cancelBtn.onclick = () => closeDialog(null);
            confirmBtn.onclick = handleConfirm;
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleConfirm();
                }
            };
            overlay.onclick = (e) => {
                if (e.target === overlay) closeDialog(null);
            };

            setTimeout(() => input.focus(), 0);
        });
    }

    // --- 导出流程核心逻辑 ---
    function getExportButton() {
        let btn = document.getElementById('gpt-rescue-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'gpt-rescue-btn';
            Object.assign(btn.style, {
                position: 'fixed', bottom: '24px', right: '24px', zIndex: '99997',
                padding: '10px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                fontWeight: 'bold', background: '#10a37f', color: '#fff', fontSize: '14px',
                boxShadow: '0 3px 12px rgba(0,0,0,.15)', userSelect: 'none'
            });
            btn.textContent = 'Export Conversations';
            btn.onclick = showExportDialog;
            document.body.appendChild(btn);
        }
        return btn;
    }

    async function exportConversations(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            conversationEntries = null,
            exportType = null,
            zipFilename = null
        } = options;
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
            return;
        }

        try {
            const zip = new JSZip();
            if (Array.isArray(conversationEntries) && conversationEntries.length > 0) {
                for (let i = 0; i < conversationEntries.length; i++) {
                    const entry = conversationEntries[i];
                    const label = entry?.title ? entry.title.slice(0, 12) : '对话';
                    btn.textContent = `📥 ${label} (${i + 1}/${conversationEntries.length})`;
                    const convData = await getConversation(entry.id, workspaceId);
                    const target = entry?.projectTitle
                        ? zip.folder(sanitizeFilename(entry.projectTitle))
                        : zip;
                    target.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                    target.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                    await sleep(jitter());
                }
            } else {
                btn.textContent = '📂 获取项目外对话…';
                const orphanIds = await collectIds(btn, workspaceId, null);
                for (let i = 0; i < orphanIds.length; i++) {
                    btn.textContent = `📥 根目录 (${i + 1}/${orphanIds.length})`;
                    const convData = await getConversation(orphanIds[i], workspaceId);
                    zip.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                    zip.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                    await sleep(jitter());
                }

                btn.textContent = '🔍 获取项目列表…';
                const projects = await getProjects(workspaceId);
                for (const project of projects) {
                    const projectFolder = zip.folder(sanitizeFilename(project.title));
                    btn.textContent = `📂 项目: ${project.title}`;
                    const projectConvIds = await collectIds(btn, workspaceId, project.id);
                    if (projectConvIds.length === 0) continue;

                    for (let i = 0; i < projectConvIds.length; i++) {
                        btn.textContent = `📥 ${project.title.substring(0,10)}... (${i + 1}/${projectConvIds.length})`;
                        const convData = await getConversation(projectConvIds[i], workspaceId);
                        projectFolder.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                        projectFolder.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                        await sleep(jitter());
                    }
                }
            }

            btn.textContent = '📦 生成 ZIP 文件…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const selectionType = exportType || ((Array.isArray(conversationEntries) && conversationEntries.length > 0) ? 'selected' : 'full');
            const filename = zipFilename || buildExportZipFilename(mode, workspaceId, selectionType, date);
            downloadFile(blob, filename);
            alert(`✅ 导出完成！`);
            btn.textContent = '✅ 完成';

        } catch (e) {
            console.error("导出过程中发生严重错误:", e);
            alert(`导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ Error';
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
            }, 3000);
        }
    }

    async function startExportProcess(mode, workspaceId, options = {}) {
        const { promptForZipName = true } = options;
        const date = new Date().toISOString().slice(0, 10);
        const defaultFilename = buildExportZipFilename(mode, workspaceId, 'full', date);
        const zipFilename = promptForZipName
            ? await promptZipFilename({
                defaultFilename,
                title: '设置导出压缩包名称'
            })
            : defaultFilename;
        if (!zipFilename) {
            alert('已取消导出。');
            return;
        }
        await exportConversations({ mode, workspaceId, zipFilename });
    }

    async function startProjectSpaceExportProcess(workspaceId = null, options = {}) {
        const { promptForZipName = true } = options;
        try {
            const date = new Date().toISOString().slice(0, 10);
            const defaultFilename = buildExportZipFilename('project', workspaceId, 'full', date);
            const zipFilename = promptForZipName
                ? await promptZipFilename({
                    defaultFilename,
                    title: '设置导出压缩包名称'
                })
                : defaultFilename;
            if (!zipFilename) {
                alert('已取消导出。');
                return;
            }
            const projectEntries = await listProjectSpaceConversations(workspaceId);
            if (projectEntries.length === 0) {
                alert('未找到项目对话。');
                return;
            }
            await exportConversations({
                mode: 'project',
                workspaceId,
                conversationEntries: projectEntries,
                exportType: 'full',
                zipFilename
            });
        } catch (err) {
            console.error('导出项目对话失败:', err);
            alert(`导出项目对话失败: ${err.message}`);
        }
    }

    async function startSelectiveExportProcess(mode, workspaceId, conversationEntries, options = {}) {
        const { promptForZipName = true } = options;
        const date = new Date().toISOString().slice(0, 10);
        const defaultFilename = buildExportZipFilename(mode, workspaceId, 'selected', date);
        const zipFilename = promptForZipName
            ? await promptZipFilename({
                defaultFilename,
                title: '设置导出压缩包名称'
            })
            : defaultFilename;
        if (!zipFilename) {
            alert('已取消导出。');
            return;
        }
        await exportConversations({ mode, workspaceId, conversationEntries, zipFilename });
    }

    function startScheduledExport(options = {}) {
        const { mode = 'personal', workspaceId = null, autoConfirm = false, source = 'schedule' } = options;
        const proceed = async () => {
            try {
                if (mode === 'project') {
                    await startProjectSpaceExportProcess(workspaceId, { promptForZipName: !autoConfirm });
                } else {
                    await startExportProcess(mode, workspaceId, { promptForZipName: !autoConfirm });
                }
            } catch (err) {
                console.error('[ChatGPT Exporter] 自动导出失败:', err);
            }
        };

        if (autoConfirm) {
            proceed();
            return;
        }

        const modeLabel = getModeLabel(mode);
        if (confirm(`Chrome 扩展请求导出 ${modeLabel} 对话（来源: ${source}）。是否开始？`)) {
            proceed();
        }
    }

    // --- API 调用函数 ---
    function extractProjectPreviewConversations(item, rawGizmo) {
        const previewSources = [
            item?.conversations?.items,
            item?.conversations,
            rawGizmo?.conversations?.items,
            rawGizmo?.conversations
        ];
        for (const source of previewSources) {
            if (Array.isArray(source) && source.length > 0) {
                return source;
            }
        }
        return [];
    }

    function mergeProjectRecords(projectMap, record) {
        if (!record?.id) return;
        const existing = projectMap.get(record.id);
        if (!existing) {
            projectMap.set(record.id, {
                id: record.id,
                title: record.title || 'Untitled Project',
                conversations: Array.isArray(record.conversations) ? [...record.conversations] : []
            });
            return;
        }

        if ((!existing.title || existing.title === 'Untitled Project') && record.title) {
            existing.title = record.title;
        }

        if (!Array.isArray(record.conversations) || record.conversations.length === 0) {
            return;
        }

        const seenConversationIds = new Set(existing.conversations.map(item => item?.id).filter(Boolean));
        record.conversations.forEach(item => {
            if (!item) return;
            if (item.id && seenConversationIds.has(item.id)) return;
            existing.conversations.push(item);
            if (item.id) seenConversationIds.add(item.id);
        });
    }

    function collectProjectsFromSidebarPayload(data, projectMap) {
        const pushProject = (entry) => {
            const rawGizmo = entry?.gizmo?.gizmo || entry?.gizmo || entry;
            const display = rawGizmo?.display || entry?.gizmo?.display || entry?.display;
            const id = rawGizmo?.id || entry?.gizmo?.id || entry?.id;
            if (!id) return;
            mergeProjectRecords(projectMap, {
                id,
                title: display?.name || rawGizmo?.name || entry?.name || 'Untitled Project',
                conversations: extractProjectPreviewConversations(entry, rawGizmo)
            });
        };

        if (Array.isArray(data?.gizmos)) {
            data.gizmos.forEach(pushProject);
        }
        if (Array.isArray(data?.items)) {
            data.items.forEach(pushProject);
        }
    }

    async function getSidebarProjects(workspaceId, options = {}) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) {
            headers['ChatGPT-Account-Id'] = resolvedWorkspaceId;
        }

        const projectMap = new Map();
        const seenCursors = new Set();
        let cursor = null;

        do {
            const query = new URLSearchParams();
            if (options.conversationsPerGizmo !== undefined) {
                query.set('conversations_per_gizmo', String(options.conversationsPerGizmo));
            }
            if (options.ownedOnly !== undefined) {
                query.set('owned_only', options.ownedOnly ? 'true' : 'false');
            }
            if (cursor) {
                query.set('cursor', cursor);
            }

            const url = query.toString()
                ? `/backend-api/gizmos/snorlax/sidebar?${query.toString()}`
                : '/backend-api/gizmos/snorlax/sidebar';

            const r = await fetch(url, { headers });
            if (!r.ok) {
                throw new Error(`获取项目列表失败 (${r.status})`);
            }

            const data = await r.json();
            collectProjectsFromSidebarPayload(data, projectMap);

            // “...更多” 对应的项目通常在后续 cursor 页里，需要持续翻页合并。
            const nextCursor = data?.cursor || data?.next_cursor || data?.nextCursor || null;
            if (!nextCursor || seenCursors.has(nextCursor)) {
                break;
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
            await sleep(jitter());
        } while (cursor);

        return Array.from(projectMap.values());
    }

    async function getProjects(workspaceId) {
        if (!workspaceId) return [];
        try {
            const projects = await getSidebarProjects(workspaceId);
            return projects.map(project => ({ id: project.id, title: project.title }));
        } catch (err) {
            console.warn(err?.message || '获取项目(Gizmo)列表失败');
            return [];
        }
    }

    function resolveWorkspaceId(workspaceId) {
        if (workspaceId) return workspaceId;
        const match = document.cookie.match(/(?:^|; )_account=([^;]+)/);
        if (match?.[1]) return match[1];
        const detectedIds = detectAllWorkspaceIds();
        return detectedIds.length > 0 ? detectedIds[0] : null;
    }

    async function getProjectSpaces(workspaceId, options = {}) {
        try {
            return await getSidebarProjects(workspaceId, options);
        } catch (err) {
            throw new Error(err?.message?.replace('获取项目列表', '获取项目空间列表') || '获取项目空间列表失败');
        }
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        if (gizmoId) {
            let cursor = '0';
            do {
                const r = await fetch(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursor}`, { headers });
                if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                const j = await r.json();
                j.items?.forEach(it => all.add(it.id));
                cursor = j.cursor;
                await sleep(jitter());
            } while (cursor);
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                do {
                    btn.textContent = `📂 项目外对话 (${is_archived ? 'Archived' : 'Active'} p${++page})`;
                    const r = await fetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                    if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                    const j = await r.json();
                    if (j.items && j.items.length > 0) {
                        j.items.forEach(it => all.add(it.id));
                        has_more = j.items.length === PAGE_LIMIT;
                        offset += j.items.length;
                    } else {
                        has_more = false;
                    }
                    await sleep(jitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    function upsertConversationEntry(map, item, extra = {}) {
        if (!item?.id) return;
        const create_time = normalizeEpochSeconds(item.create_time || 0);
        const update_time = normalizeEpochSeconds(item.update_time || item.create_time || 0);
        const entry = {
            id: item.id,
            title: item.title || 'Untitled Conversation',
            create_time,
            update_time,
            is_archived: item.is_archived ?? extra.is_archived ?? false,
            projectId: extra.projectId || null,
            projectTitle: extra.projectTitle || null
        };
        const existing = map.get(entry.id);
        if (!existing) {
            map.set(entry.id, entry);
            return;
        }
        if (!existing.projectTitle && entry.projectTitle) {
            existing.projectTitle = entry.projectTitle;
            existing.projectId = entry.projectId;
        }
        if (!existing.create_time && entry.create_time) {
            existing.create_time = entry.create_time;
        }
        existing.is_archived = existing.is_archived || entry.is_archived;
        if ((entry.update_time || 0) > (existing.update_time || 0)) {
            existing.update_time = entry.update_time;
        }
        if (existing.title === 'Untitled Conversation' && entry.title) {
            existing.title = entry.title;
        }
    }

    function sortProjectConversationEntries(entries) {
        const groups = new Map();
        entries.forEach(entry => {
            const key = entry?.projectId || '__ungrouped__';
            const existing = groups.get(key) || {
                latestUpdate: 0,
                items: []
            };
            existing.items.push(entry);
            existing.latestUpdate = Math.max(existing.latestUpdate || 0, entry?.update_time || 0);
            groups.set(key, existing);
        });

        return Array.from(groups.values())
            .sort((a, b) => (b.latestUpdate || 0) - (a.latestUpdate || 0))
            .flatMap(group => group.items.sort((a, b) => (b.update_time || 0) - (a.update_time || 0)));
    }

    async function listConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        const map = new Map();
        const addEntry = (item, extra = {}) => upsertConversationEntry(map, item, extra);

        for (const is_archived of [false, true]) {
            let offset = 0;
            let has_more = true;
            do {
                const r = await fetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                if (!r.ok) throw new Error(`列举对话列表失败 (${r.status})`);
                const j = await r.json();
                if (j.items && j.items.length > 0) {
                    j.items.forEach(it => addEntry(it, { is_archived }));
                    has_more = j.items.length === PAGE_LIMIT;
                    offset += j.items.length;
                } else {
                    has_more = false;
                }
                await sleep(jitter());
            } while (has_more);
        }

        if (workspaceId) {
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                let cursor = '0';
                do {
                    const r = await fetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers });
                    if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                    const j = await r.json();
                    j.items?.forEach(it => addEntry(it, { projectId: project.id, projectTitle: project.title }));
                    cursor = j.cursor;
                    await sleep(jitter());
                } while (cursor);
            }
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function listProjectSpaceConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const map = new Map();
        const projects = await getProjectSpaces(resolvedWorkspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: true });

        for (const project of projects) {
            let cursor = '0';
            let fetched = false;
            do {
                const r = await fetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers });
                if (!r.ok) {
                    if (!fetched && Array.isArray(project.conversations) && project.conversations.length > 0) {
                        console.warn(`项目对话列表请求失败 (${r.status})，使用侧边栏返回的预览对话。`);
                        project.conversations.forEach(item => upsertConversationEntry(map, item, {
                            projectId: project.id,
                            projectTitle: project.title
                        }));
                        cursor = null;
                        break;
                    }
                    throw new Error(`列举项目对话列表失败 (${r.status})`);
                }
                const j = await r.json();
                j.items?.forEach(item => upsertConversationEntry(map, item, {
                    projectId: project.id,
                    projectTitle: project.title
                }));
                cursor = j.cursor;
                fetched = true;
                await sleep(jitter());
            } while (cursor);
        }

        return sortProjectConversationEntries(Array.from(map.values()));
    }

    async function getConversation(id, workspaceId) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }
        const r = await fetch(`/backend-api/conversation/${id}`, { headers });
        if (!r.ok) throw new Error(`获取对话详情失败 conv ${id} (${r.status})`);
        const j = await r.json();
        j.__fetched_at = new Date().toISOString();
        return j;
    }

    // --- UI 相关函数 ---
    // (UI部分无变动，此处省略以保持简洁)
    /**
     * [新增] 全面检测函数，返回所有找到的ID
     * @returns {string[]} - 返回包含所有唯一Workspace ID的数组
     */
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds); // 从网络拦截的结果开始

        // 扫描 __NEXT_DATA__
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
            // 遍历所有账户信息
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) {
                Object.values(accounts).forEach(acc => {
                    if (acc?.account?.id) {
                        foundIds.add(acc.account.id);
                    }
                });
            }
        } catch (e) {}

        // 扫描 localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('account') || key.includes('workspace'))) {
                    const value = localStorage.getItem(key);
                    if (value && /^[a-z0-9]{2,}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         const extractedId = value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                         if(extractedId) foundIds.add(extractedId[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}

        console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds));
        return Array.from(foundIds);
    }

    function showConversationPicker(options = {}) {
        const { mode = 'personal', workspaceId = null } = options;
        const existing = document.getElementById('export-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '720px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);
        const state = {
            list: [],
            filtered: [],
            selected: new Set(),
            query: '',
            scope: mode === 'project' ? 'project' : 'all',
            scopeLocked: mode === 'project',
            archived: 'all',
            timeField: 'update',
            loading: true,
            pageSize: 100,
            visibleCount: 100,
            startDate: '',
            endDate: ''
        };

        const renderBase = () => {
            const modeLabel = getModeLabel(mode);
            const workspaceLabel = workspaceId ? `（${workspaceId}）` : '';
            dialog.innerHTML = `
                <h2 style="margin-top:0; margin-bottom: 12px; font-size: 18px;">选择要导出的对话</h2>
                <div style="margin-bottom: 12px; color: #666; font-size: 12px;">空间：${modeLabel}${workspaceLabel}</div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input id="conv-search" type="text" placeholder="搜索标题/项目名/ID"
                        style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">
                    <select id="filter-scope" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部范围</option>
                        <option value="project">仅项目</option>
                        <option value="root">仅项目外</option>
                    </select>
                    <select id="filter-archived" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部状态</option>
                        <option value="active">仅未归档</option>
                        <option value="archived">仅已归档</option>
                    </select>
                </div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
                    <select id="filter-time-field" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="update">按更新时间</option>
                        <option value="create">按创建时间</option>
                    </select>
                    <input id="filter-start-date" type="date" style="padding: 8px; border-radius: 6px; border: 1px solid #ccc;">
                    <span style="color: #666; font-size: 12px;">至</span>
                    <input id="filter-end-date" type="date" style="padding: 8px; border-radius: 6px; border: 1px solid #ccc;">
                    <button id="clear-date-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空日期</button>
                </div>
                <div id="conv-status" style="margin-bottom: 8px; font-size: 12px; color: #666;">正在加载列表...</div>
                <div id="conv-list" style="max-height: 360px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: #fff;"></div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
                    <div style="display: flex; gap: 8px;">
                        <button id="select-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">全选</button>
                        <button id="clear-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空</button>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="back-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">返回</button>
                        <button id="export-qa-btn" style="padding: 8px 12px; border: 1px solid #10a37f; border-radius: 6px; background: #fff; color: #10a37f; cursor: pointer; font-weight: bold;" disabled>选择Q&A导出（需选 1 条）</button>
                        <button id="export-selected-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;" disabled>导出选中 (0)</button>
                    </div>
                </div>
            `;

            const searchInput = dialog.querySelector('#conv-search');
            const scopeSelect = dialog.querySelector('#filter-scope');
            const archivedSelect = dialog.querySelector('#filter-archived');
            const timeFieldSelect = dialog.querySelector('#filter-time-field');
            const startDateInput = dialog.querySelector('#filter-start-date');
            const endDateInput = dialog.querySelector('#filter-end-date');
            const clearDateBtn = dialog.querySelector('#clear-date-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const backBtn = dialog.querySelector('#back-btn');
            const exportBtn = dialog.querySelector('#export-selected-btn');
            const qaBtn = dialog.querySelector('#export-qa-btn');

            if (state.scopeLocked && scopeSelect) {
                scopeSelect.value = 'project';
                scopeSelect.disabled = true;
                scopeSelect.style.opacity = '0.7';
                scopeSelect.style.cursor = 'not-allowed';
                scopeSelect.title = '项目对话模式仅包含项目内对话';
            }

            searchInput.oninput = (e) => {
                state.query = e.target.value || '';
                applyFilters();
                renderList();
            };
            scopeSelect.onchange = (e) => {
                state.scope = e.target.value;
                applyFilters();
                renderList();
            };
            archivedSelect.onchange = (e) => {
                state.archived = e.target.value;
                applyFilters();
                renderList();
            };
            timeFieldSelect.onchange = (e) => {
                state.timeField = e.target.value;
                applyFilters();
                renderList();
            };
            startDateInput.onchange = (e) => {
                state.startDate = e.target.value || '';
                applyFilters();
                renderList();
            };
            endDateInput.onchange = (e) => {
                state.endDate = e.target.value || '';
                applyFilters();
                renderList();
            };
            clearDateBtn.onclick = () => {
                state.startDate = '';
                state.endDate = '';
                startDateInput.value = '';
                endDateInput.value = '';
                applyFilters();
                renderList();
            };
            selectAllBtn.onclick = () => {
                state.filtered.forEach(item => state.selected.add(item.id));
                renderList();
            };
            clearAllBtn.onclick = () => {
                state.selected.clear();
                renderList();
            };
            backBtn.onclick = () => {
                closeDialog();
                showExportDialog();
            };
            if (qaBtn) {
                qaBtn.onclick = () => {
                    if (state.selected.size !== 1) return;
                    const selectedId = Array.from(state.selected)[0];
                    const conversationEntry = state.list.find(item => item.id === selectedId);
                    if (!conversationEntry) return;
                    closeDialog();
                    showTurnPicker({ mode, workspaceId, conversationEntry });
                };
            }
            exportBtn.onclick = async () => {
                if (state.selected.size === 0) return;
                const selectedList = state.list.filter(item => state.selected.has(item.id));
                closeDialog();
                await startSelectiveExportProcess(mode, workspaceId, selectedList);
            };
        };

        const applyFilters = () => {
            const query = state.query.trim().toLowerCase();
            const startBound = parseDateInputToEpoch(state.startDate, false);
            const endBound = parseDateInputToEpoch(state.endDate, true);
            state.filtered = state.list.filter(item => {
                const text = `${item.title || ''} ${item.projectTitle || ''} ${item.id || ''}`.toLowerCase();
                if (query && !text.includes(query)) return false;
                if (state.scope === 'project' && !item.projectTitle) return false;
                if (state.scope === 'root' && item.projectTitle) return false;
                if (state.archived === 'active' && item.is_archived) return false;
                if (state.archived === 'archived' && !item.is_archived) return false;
                if (startBound || endBound) {
                    const sourceTime = state.timeField === 'create'
                        ? item.create_time
                        : item.update_time;
                    const ts = normalizeEpochSeconds(sourceTime || 0);
                    if (!ts) return false;
                    if (startBound && ts < startBound) return false;
                    if (endBound && ts > endBound) return false;
                }
                return true;
            });
            state.visibleCount = state.pageSize;
        };

        const renderList = () => {
            const statusEl = dialog.querySelector('#conv-status');
            const listEl = dialog.querySelector('#conv-list');
            const exportBtn = dialog.querySelector('#export-selected-btn');
            const qaBtn = dialog.querySelector('#export-qa-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const controlsDisabled = state.loading;

            if (selectAllBtn) selectAllBtn.disabled = controlsDisabled;
            if (clearAllBtn) clearAllBtn.disabled = controlsDisabled;
            if (exportBtn) exportBtn.disabled = controlsDisabled || state.selected.size === 0;
            if (qaBtn) qaBtn.disabled = controlsDisabled || state.selected.size !== 1;

            listEl.innerHTML = '';
            if (state.loading) {
                statusEl.textContent = '正在加载列表...';
                return;
            }

            const visibleCount = Math.min(state.visibleCount, state.filtered.length);
            statusEl.textContent = `共 ${state.list.length} 条，当前筛选 ${state.filtered.length} 条，显示 ${visibleCount} 条，已选 ${state.selected.size} 条`;
            exportBtn.textContent = `导出选中 (${state.selected.size})`;
            if (qaBtn) qaBtn.textContent = state.selected.size === 1 ? '选择Q&A导出' : '选择Q&A导出（需选 1 条）';

            if (state.filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = '没有匹配的对话。';
                empty.style.color = '#999';
                empty.style.padding = '8px 4px';
                listEl.appendChild(empty);
                return;
            }

            const visibleItems = state.filtered.slice(0, state.visibleCount);
            visibleItems.forEach(item => {
                const label = document.createElement('label');
                Object.assign(label.style, {
                    display: 'flex', gap: '8px', padding: '8px',
                    border: '1px solid #e5e7eb', borderRadius: '6px',
                    marginBottom: '8px', cursor: 'pointer', alignItems: 'flex-start'
                });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = state.selected.has(item.id);
                checkbox.onchange = (e) => {
                    if (e.target.checked) {
                        state.selected.add(item.id);
                    } else {
                        state.selected.delete(item.id);
                    }
                    renderList();
                };

                const content = document.createElement('div');
                content.style.flex = '1';

                const title = document.createElement('div');
                title.textContent = item.title || 'Untitled Conversation';
                title.style.fontWeight = 'bold';
                title.style.fontSize = '14px';

                const meta = document.createElement('div');
                meta.style.fontSize = '12px';
                meta.style.color = '#666';
                const timeLabelPrefix = state.timeField === 'create' ? '创建' : '更新';
                const timeValue = state.timeField === 'create' ? item.create_time : item.update_time;
                const timeLabel = formatTimestamp(timeValue) || '未知';
                meta.textContent = `${timeLabelPrefix}: ${timeLabel}`;

                const tags = document.createElement('div');
                tags.style.marginTop = '6px';
                tags.style.display = 'flex';
                tags.style.gap = '6px';
                tags.style.flexWrap = 'wrap';

                if (item.projectTitle) {
                    const projectTag = document.createElement('span');
                    projectTag.textContent = `项目: ${item.projectTitle}`;
                    Object.assign(projectTag.style, {
                        background: '#eef2ff', color: '#4338ca',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(projectTag);
                }

                if (item.is_archived) {
                    const archivedTag = document.createElement('span');
                    archivedTag.textContent = '已归档';
                    Object.assign(archivedTag.style, {
                        background: '#fef3c7', color: '#92400e',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(archivedTag);
                }

                content.appendChild(title);
                content.appendChild(meta);
                if (tags.childNodes.length > 0) content.appendChild(tags);

                label.appendChild(checkbox);
                label.appendChild(content);
                listEl.appendChild(label);
            });

            if (state.filtered.length > state.visibleCount) {
                const loadMore = document.createElement('button');
                loadMore.textContent = `加载更多（剩余 ${state.filtered.length - state.visibleCount} 条）`;
                Object.assign(loadMore.style, {
                    width: '100%', padding: '8px 12px', border: '1px solid #ccc',
                    borderRadius: '6px', background: '#fff', cursor: 'pointer'
                });
                loadMore.onclick = () => {
                    state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filtered.length);
                    renderList();
                };
                listEl.appendChild(loadMore);
            }
        };

        renderBase();
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

        const listPromise = mode === 'project'
            ? listProjectSpaceConversations(workspaceId)
            : listConversations(workspaceId);
        listPromise
            .then(list => {
                state.list = list;
                state.loading = false;
                applyFilters();
                renderList();
            })
            .catch(err => {
                const statusEl = dialog.querySelector('#conv-status');
                state.loading = false;
                state.list = [];
                state.filtered = [];
                statusEl.textContent = `加载失败: ${err.message}`;
                renderList();
            });
    }


    // --- [新增] Q&A 细粒度导出（按轮次选择） ---
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function extractTextFromMessage(msg) {
        const content = msg?.content;
        if (!content) return '';

        // Prefer parts[] when available (works for text/multimodal_text/etc.).
        if (Array.isArray(content.parts)) {
            const rawText = content.parts
                .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            return rawText || '';
        }

        // Some payloads store text directly.
        if (typeof content.text === 'string') return content.text;
        return '';
    }

    function getConversationRootId(mapping) {
        if (!mapping) return null;
        const keys = Object.keys(mapping);
        if (mapping['client-created-root']) return 'client-created-root';
        return keys.find(id => !mapping[id]?.parent) || keys[0] || null;
    }

    function getMainPathNodeIds(convData) {
        const mapping = convData?.mapping;
        if (!mapping) return [];
        const rootId = getConversationRootId(mapping);
        let nodeId = convData?.current_node || rootId;
        const path = [];
        const visited = new Set();
        while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
            visited.add(nodeId);
            path.push(nodeId);
            nodeId = mapping[nodeId].parent;
        }
        path.reverse();
        // Ensure root is included when current_node is missing/invalid
        if (path.length === 0 && rootId) return [rootId];
        return path;
    }

    function extractProcessedMessageForQA(msg) {
        if (!msg) return null;
        const author = msg.author?.role;
        if (!author || author === 'system') return null;

        const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
            msg.metadata?.is_contextual_answers_system_message;
        if (isHidden) return null;

        const rawText = extractTextFromMessage(msg);
        if (!rawText) return null;

        const contentReferences = msg.metadata?.content_references || [];
        let processedText = rawText;
        let footnotes = [];
        if (Array.isArray(contentReferences) && contentReferences.length > 0) {
            const processed = processContentReferences(rawText, contentReferences);
            processedText = processed.text;
            footnotes = processed.footnotes;
        }
        const cleaned = cleanMessageContent(processedText);
        if (!cleaned) return null;

        return {
            role: author,
            content: cleaned,
            create_time: msg.create_time || null,
            footnotes
        };
    }

    function extractVisibleMessagesLinearForQA(convData) {
        const mapping = convData?.mapping;
        if (!mapping) return [];

        const nodeIds = getMainPathNodeIds(convData);
        const messages = [];
        nodeIds.forEach(nodeId => {
            const node = mapping[nodeId];
            const msg = node?.message;
            const processed = extractProcessedMessageForQA(msg);
            if (processed) messages.push(processed);
        });
        return messages;
    }

    function buildTurnsFromConversation(convData) {
        const msgs = extractVisibleMessagesLinearForQA(convData);
        const turns = [];
        for (const m of msgs) {
            if (m.role === 'user') {
                turns.push({
                    user: m,
                    assistants: []
                });
                continue;
            }
            if (m.role === 'assistant') {
                if (turns.length === 0) {
                    turns.push({ user: null, assistants: [m] });
                } else {
                    turns[turns.length - 1].assistants.push(m);
                }
            }
        }
        // Keep only turns that have at least one side visible
        return turns.filter(t => (t.user && t.user.content) || (t.assistants && t.assistants.length > 0));
    }

    function convertSelectedTurnsToMarkdown(conversationEntry, convData, selectedTurns, selectedIndexes) {
        const title = conversationEntry?.title || convData?.title || 'Untitled Conversation';
        const md = [];
        md.push(`# ${title}`);
        md.push('');
        selectedTurns.forEach((turn, i) => {
            const originalIdx = selectedIndexes[i];
            md.push(`## 第 ${originalIdx + 1} 轮`);
            md.push('');
            md.push('### Q');
            const qText = turn.user?.content || '(无提问)';
            md.push(qText);
            if (turn.user?.create_time) {
                md.push('');
                md.push(`> User 时间: ${formatTimestamp(turn.user.create_time) || '未知'}`);
            }
            if (Array.isArray(turn.user?.footnotes) && turn.user.footnotes.length > 0) {
                md.push('');
                turn.user.footnotes
                    .slice()
                    .sort((a, b) => a.index - b.index)
                    .forEach(note => {
                        if (!note.url) return;
                        const t = note.title ? ` "${note.title}"` : '';
                        md.push(`[${note.index}]: ${note.url}${t}`);
                    });
            }
            md.push('');
            md.push('### A');
            if (!turn.assistants || turn.assistants.length === 0) {
                md.push('(无回答)');
            } else {
                turn.assistants.forEach((aMsg, ai) => {
                    if (ai > 0) md.push('\n---\n');
                    md.push(aMsg.content);
                    if (aMsg.create_time) {
                        md.push('');
                        md.push(`> Assistant 时间: ${formatTimestamp(aMsg.create_time) || '未知'}`);
                    }
                    if (Array.isArray(aMsg.footnotes) && aMsg.footnotes.length > 0) {
                        md.push('');
                        aMsg.footnotes
                            .slice()
                            .sort((x, y) => x.index - y.index)
                            .forEach(note => {
                                if (!note.url) return;
                                const t = note.title ? ` "${note.title}"` : '';
                                md.push(`[${note.index}]: ${note.url}${t}`);
                            });
                    }
                });
            }
            md.push('');
        });
        return md.join('\n').trim() + '\n';
    }

    async function exportConversationSelectedTurns(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            conversationEntry,
            selectedTurnIndexes = [],
            zipFilename = null
        } = options;
        if (!conversationEntry?.id) throw new Error('缺少 conversationEntry.id');
        if (!Array.isArray(selectedTurnIndexes) || selectedTurnIndexes.length === 0) return;

        const date = new Date().toISOString().slice(0, 10);
        const convShortId = conversationEntry.id.includes('-')
            ? conversationEntry.id.split('-').pop()
            : conversationEntry.id;
        const resolvedZipName = zipFilename || await promptZipFilename({
            defaultFilename: buildQaZipFilename(mode, workspaceId, convShortId, date),
            title: '设置 Q&A 导出压缩包名称'
        });
        if (!resolvedZipName) {
            alert('已取消导出。');
            return;
        }

        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token');
        }

        const convData = await getConversation(conversationEntry.id, workspaceId);
        const turns = buildTurnsFromConversation(convData);
        const sortedIdx = Array.from(new Set(selectedTurnIndexes))
            .filter(i => Number.isInteger(i) && i >= 0 && i < turns.length)
            .sort((a, b) => a - b);

        if (sortedIdx.length === 0) {
            throw new Error('未选中任何有效轮次');
        }

        const selectedTurns = sortedIdx.map(i => turns[i]);
        const qaJson = {
            conversation_id: convData.conversation_id || conversationEntry.id,
            title: conversationEntry.title || convData.title || 'Untitled Conversation',
            mode,
            workspace_id: workspaceId || null,
            selected_turn_indexes: sortedIdx,
            turns: selectedTurns.map((t, idx) => ({
                turn_index: sortedIdx[idx],
                user: t.user ? {
                    content: t.user.content,
                    create_time: t.user.create_time || null,
                    footnotes: t.user.footnotes || []
                } : null,
                assistants: (t.assistants || []).map(a => ({
                    content: a.content,
                    create_time: a.create_time || null,
                    footnotes: a.footnotes || []
                }))
            })),
            __fetched_at: convData.__fetched_at || new Date().toISOString()
        };

        const md = convertSelectedTurnsToMarkdown(conversationEntry, convData, selectedTurns, sortedIdx);

        const zip = new JSZip();
        const titleSafe = sanitizeFilename(qaJson.title).slice(0, 60) || 'Untitled_Conversation';
        const convId = qaJson.conversation_id || conversationEntry.id;
        const shortId = convId.includes('-') ? convId.split('-').pop() : convId;
        const baseName = `${titleSafe}_${shortId}_qa_selected`;

        const target = conversationEntry?.projectTitle
            ? zip.folder(sanitizeFilename(conversationEntry.projectTitle))
            : zip;

        target.file(`${baseName}.json`, JSON.stringify(qaJson, null, 2));
        target.file(`${baseName}.md`, md);

        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        downloadFile(blob, resolvedZipName);

        alert('✅ Q&A 选择导出完成！');
    }

    function showTurnPicker(options = {}) {
        const { mode = 'personal', workspaceId = null, conversationEntry } = options;
        const existing = document.getElementById('qa-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'qa-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'qa-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '720px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const safeRemoveOverlay = () => {
            try {
                if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
            } catch (_) {}
        };

        const state = {
            turns: [],
            filtered: [],
            selected: new Set(),
            query: '',
            loading: true,
            pageSize: 100,
            visibleCount: 100
        };

        const renderBase = () => {
            const modeLabel = getModeLabel(mode);
            const workspaceLabel = workspaceId ? `（${escapeHtml(workspaceId)}）` : '';
            const title = conversationEntry?.title || 'Untitled Conversation';

            dialog.innerHTML = `
                <h2 style="margin-top:0; margin-bottom: 12px; font-size: 18px;">选择要导出的 Q&A</h2>
                <div style="margin-bottom: 8px; color: #666; font-size: 12px;">空间：${modeLabel}${workspaceLabel}</div>
                <div style="margin-bottom: 12px; color: #111; font-size: 13px; font-weight: bold;">对话：${escapeHtml(title)}</div>

                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input id="turn-search" type="text" placeholder="搜索本对话内容"
                        style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">
                </div>

                <div id="turn-status" style="margin-bottom: 8px; font-size: 12px; color: #666;">正在加载对话...</div>
                <div id="turn-list" style="max-height: 360px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: #fff;"></div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
                    <div style="display: flex; gap: 8px;">
                        <button id="turn-select-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">全选</button>
                        <button id="turn-clear-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空</button>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="turn-back-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">返回</button>
                        <button id="turn-export-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;" disabled>导出选中 (0)</button>
                    </div>
                </div>
            `;

            const searchInput = dialog.querySelector('#turn-search');
            const selectAllBtn = dialog.querySelector('#turn-select-all-btn');
            const clearAllBtn = dialog.querySelector('#turn-clear-all-btn');
            const backBtn = dialog.querySelector('#turn-back-btn');
            const exportBtn = dialog.querySelector('#turn-export-btn');

            searchInput.oninput = (e) => {
                state.query = e.target.value || '';
                applyFilters();
                renderList();
            };
            selectAllBtn.onclick = () => {
                state.filtered.forEach(item => state.selected.add(item.index));
                renderList();
            };
            clearAllBtn.onclick = () => {
                state.selected.clear();
                renderList();
            };
            backBtn.onclick = () => {
                safeRemoveOverlay();
                showConversationPicker({ mode, workspaceId });
            };
            exportBtn.onclick = async () => {
                if (state.selected.size === 0) return;
                const idx = Array.from(state.selected).slice().sort((a, b) => a - b);

                exportBtn.disabled = true;
                exportBtn.textContent = '导出中...';
                safeRemoveOverlay();

                try {
                    await exportConversationSelectedTurns({
                        mode,
                        workspaceId,
                        conversationEntry,
                        selectedTurnIndexes: idx
                    });
                } catch (err) {
                    console.error('[ChatGPT Exporter][QA] 导出失败:', err);
                    alert(`导出失败：${err?.message || err}`);
                }
            };
        };

        const applyFilters = () => {
            const q = state.query.trim().toLowerCase();
            const indexed = state.turns.map((turn, index) => ({ turn, index }));
            if (!q) {
                state.filtered = indexed;
            } else {
                state.filtered = indexed.filter(({ turn }) => {
                    const qText = (turn.user?.content || '').toLowerCase();
                    const aText = (turn.assistants || []).map(a => a.content || '').join('\n').toLowerCase();
                    return qText.includes(q) || aText.includes(q);
                });
            }
            state.visibleCount = state.pageSize;
        };

        const renderList = () => {
            const statusEl = dialog.querySelector('#turn-status');
            const listEl = dialog.querySelector('#turn-list');
            const exportBtn = dialog.querySelector('#turn-export-btn');
            const selectAllBtn = dialog.querySelector('#turn-select-all-btn');
            const clearAllBtn = dialog.querySelector('#turn-clear-all-btn');

            const controlsDisabled = state.loading;
            if (selectAllBtn) selectAllBtn.disabled = controlsDisabled;
            if (clearAllBtn) clearAllBtn.disabled = controlsDisabled;
            if (exportBtn) exportBtn.disabled = controlsDisabled || state.selected.size === 0;

            listEl.innerHTML = '';
            if (state.loading) {
                statusEl.textContent = '正在加载对话...';
                return;
            }

            const visibleCount = Math.min(state.visibleCount, state.filtered.length);
            statusEl.textContent = `共 ${state.turns.length} 轮，当前筛选 ${state.filtered.length} 轮，显示 ${visibleCount} 轮，已选 ${state.selected.size} 轮`;
            exportBtn.textContent = `导出选中 (${state.selected.size})`;

            if (state.filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = '没有匹配的轮次。';
                empty.style.color = '#999';
                empty.style.padding = '8px 4px';
                listEl.appendChild(empty);
                return;
            }

            const visibleItems = state.filtered.slice(0, state.visibleCount);
            visibleItems.forEach(({ turn, index }) => {
                const label = document.createElement('label');
                Object.assign(label.style, {
                    display: 'flex', gap: '8px', padding: '8px',
                    border: '1px solid #e5e7eb', borderRadius: '6px',
                    marginBottom: '8px', cursor: 'pointer', alignItems: 'flex-start'
                });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = state.selected.has(index);
                checkbox.onchange = (e) => {
                    if (e.target.checked) state.selected.add(index);
                    else state.selected.delete(index);
                    renderList();
                };

                const content = document.createElement('div');
                content.style.flex = '1';

                const title = document.createElement('div');
                title.textContent = `第 ${index + 1} 轮`;
                title.style.fontWeight = 'bold';
                title.style.fontSize = '14px';

                const meta = document.createElement('div');
                meta.style.fontSize = '12px';
                meta.style.color = '#666';
                const userTime = turn.user?.create_time ? (formatTimestamp(turn.user.create_time) || '未知') : '未知';
                const aCount = (turn.assistants || []).length;
                meta.textContent = `User 时间: ${userTime} | Assistant 条数: ${aCount}`;

                const preview = document.createElement('div');
                preview.style.marginTop = '6px';
                preview.style.fontSize = '12px';
                preview.style.color = '#333';
                const qText = (turn.user?.content || '(无提问)').replace(/\s+/g, ' ').slice(0, 140);
                const aText = (turn.assistants || []).map(a => a.content || '').join(' ').replace(/\s+/g, ' ').slice(0, 140);
                preview.textContent = `Q: ${qText}${qText.length >= 140 ? '…' : ''}\nA: ${aText}${aText.length >= 140 ? '…' : ''}`;

                content.appendChild(title);
                content.appendChild(meta);
                content.appendChild(preview);

                label.appendChild(checkbox);
                label.appendChild(content);
                listEl.appendChild(label);
            });

            if (state.filtered.length > state.visibleCount) {
                const loadMore = document.createElement('button');
                loadMore.textContent = `加载更多（剩余 ${state.filtered.length - state.visibleCount} 轮）`;
                Object.assign(loadMore.style, {
                    width: '100%', padding: '8px 12px', border: '1px solid #ccc',
                    borderRadius: '6px', background: '#fff', cursor: 'pointer'
                });
                loadMore.onclick = () => {
                    state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filtered.length);
                    renderList();
                };
                listEl.appendChild(loadMore);
            }
        };

        renderBase();
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) safeRemoveOverlay(); };

        (async () => {
            try {
                if (!await ensureAccessToken()) {
                    throw new Error('无法获取 Access Token');
                }
                const convData = await getConversation(conversationEntry.id, workspaceId);
                state.turns = buildTurnsFromConversation(convData);
                state.loading = false;
                applyFilters();
                renderList();
            } catch (err) {
                console.error('[ChatGPT Exporter][QA] 加载对话失败:', err);
                state.loading = false;
                state.turns = [];
                state.filtered = [];
                const statusEl = dialog.querySelector('#turn-status');
                if (statusEl) statusEl.textContent = `加载失败: ${err?.message || err}`;
                renderList();
            }
        })();
    }

    /**
     * [重构] 多步骤、用户主导的导出对话框
     */
    function showExportDialog() {
        if (document.getElementById('export-dialog-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '450px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);

        let pendingTeamAction = null;
        const renderStep = (step, action = null) => {
            pendingTeamAction = action;
            let html = '';
            switch (step) {
                case 'team': {
                    const detectedIds = detectAllWorkspaceIds();
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">导出团队空间（项目外 + 项目内）</h2>`;

                    if (detectedIds.length > 1) {
                        html += `<div style="background: #eef2ff; border: 1px solid #818cf8; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 12px 0; font-weight: bold; color: #4338ca;">🔎 检测到多个 Workspace，请选择一个:</p>
                                     <div id="workspace-id-list">`;
                        detectedIds.forEach((id, index) => {
                            html += `<label style="display: block; margin-bottom: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid #ddd; background: #fff;">
                                         <input type="radio" name="workspace_id" value="${id}" ${index === 0 ? 'checked' : ''}>
                                         <code style="margin-left: 8px; font-family: monospace; color: #555;">${id}</code>
                                      </label>`;
                        });
                        html += `</div></div>`;
                    } else if (detectedIds.length === 1) {
                        html += `<div style="background: #f0fdf4; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 8px 0; font-weight: bold; color: #166534;">✅ 已自动检测到 Workspace ID:</p>
                                     <code id="workspace-id-code" style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #4338ca; word-break: break-all;">${detectedIds[0]}</code>
                                   </div>`;
                    } else {
                        html += `<div style="background: #fffbeb; border: 1px solid #facc15; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0; color: #92400e;">⚠️ 未能自动检测到 Workspace ID。</p>
                                     <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">请尝试刷新页面或打开一个团队对话，或在下方手动输入。</p>
                                   </div>
                                   <label for="team-id-input" style="display: block; margin-bottom: 8px; font-weight: bold;">手动输入 Team Workspace ID:</label>
                                   <input type="text" id="team-id-input" placeholder="粘贴您的 Workspace ID (ws-...)" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">`;
                    }

                    let actionButtons = '';
                    if (pendingTeamAction === 'all') {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>`;
                    } else if (pendingTeamAction === 'select') {
                        actionButtons = `<button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    } else {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>
                                     <button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    }

                    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px;">
                                 <button id="back-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">返回</button>
                                 <div style="display: flex; gap: 8px;">
                                     ${actionButtons}
                                 </div>
                               </div>`;
                    break;
                }

                case 'initial':
                default:
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">选择要导出的空间</h2>
                                <div style="display: flex; flex-direction: column; gap: 16px;">
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">个人空间（仅项目外）</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出当前个人 workspace 下未进入项目的对话。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-personal-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-personal-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">项目对话（仅项目内）</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出当前 workspace 下的项目对话，将按项目自动分组。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-project-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-project-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">团队空间（项目外 + 项目内）</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出团队 workspace 下的全部对话，将自动检测 ID。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-team-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-team-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                </div>
                                <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                                    <button id="cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                                </div>`;
                    break;
            }
            dialog.innerHTML = html;
            attachListeners(step);
        };

        const attachListeners = (step) => {
            if (step === 'initial') {
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null);
                };
                document.getElementById('select-personal-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'personal', workspaceId: null });
                };
                document.getElementById('select-project-btn').onclick = () => {
                    closeDialog();
                    startProjectSpaceExportProcess();
                };
                document.getElementById('select-project-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'project', workspaceId: null });
                };
                const startTeamFlow = (action) => {
                    const detectedIds = detectAllWorkspaceIds();
                    if (detectedIds.length === 1) {
                        const workspaceId = detectedIds[0];
                        closeDialog();
                        if (action === 'all') {
                            startExportProcess('team', workspaceId);
                        } else {
                            showConversationPicker({ mode: 'team', workspaceId });
                        }
                        return;
                    }
                    renderStep('team', action);
                };
                document.getElementById('select-team-btn').onclick = () => startTeamFlow('all');
                document.getElementById('select-team-picker-btn').onclick = () => startTeamFlow('select');
                document.getElementById('cancel-btn').onclick = closeDialog;
            } else if (step === 'team') {
                document.getElementById('back-btn').onclick = () => renderStep('initial');
                const resolveWorkspaceId = () => {
                    let workspaceId = '';
                    const radioChecked = document.querySelector('input[name="workspace_id"]:checked');
                    const codeEl = document.getElementById('workspace-id-code');
                    const inputEl = document.getElementById('team-id-input');

                    if (radioChecked) {
                        workspaceId = radioChecked.value;
                    } else if (codeEl) {
                        workspaceId = codeEl.textContent;
                    } else if (inputEl) {
                        workspaceId = inputEl.value.trim();
                    }

                    if (!workspaceId) {
                        alert('请选择或输入一个有效的 Team Workspace ID！');
                        return;
                    }
                    return workspaceId;
                };
                const exportAllBtn = document.getElementById('start-team-export-btn');
                const pickerBtn = document.getElementById('start-team-picker-btn');
                if (exportAllBtn) exportAllBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    startExportProcess('team', workspaceId);
                };
                if (pickerBtn) pickerBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    showConversationPicker({ mode: 'team', workspaceId });
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }


    window.ChatGPTExporter = window.ChatGPTExporter || {};
    Object.assign(window.ChatGPTExporter, {
        showDialog: showExportDialog,
        startManualExport: (mode = 'personal', workspaceId = null) => {
            if (mode === 'project') {
                return startProjectSpaceExportProcess(workspaceId);
            }
            return startExportProcess(mode, workspaceId);
        },
        startScheduledExport
    });

    document.documentElement.setAttribute('data-chatgpt-exporter-ready', '1');
    window.dispatchEvent(new CustomEvent('CHATGPT_EXPORTER_READY'));

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data?.type !== 'CHATGPT_EXPORTER_COMMAND') return;
        const api = window.ChatGPTExporter;
        if (!api) return;
        try {
            switch (data.action) {
                case 'START_SCHEDULED_EXPORT':
                    api.startScheduledExport(data.payload || {});
                    break;
                case 'OPEN_DIALOG':
                    api.showDialog();
                    break;
                case 'START_MANUAL_EXPORT':
                    api.startManualExport(data.payload?.mode, data.payload?.workspaceId);
                    break;
                default:
                    console.warn('[ChatGPT Exporter] 未知命令:', data.action);
            }
        } catch (err) {
            console.error('[ChatGPT Exporter] 处理命令失败:', err);
        }
    });

})();
