// codePanel.js — Monaco-based project editor panel
// Loaded via script tag; no ES6 modules, no bundler.

(function() {
    "use strict";

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function(c) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
        });
    }

    function getFileIcon(filename) {
        var ext = (filename.split(".").pop() || "").toLowerCase();
        var icons = { js: "🟨", mjs: "🟨", cjs: "🟨", ts: "🟦", json: "📋", md: "📝", html: "🌐", css: "🎨", sh: "⚡", env: "🔒", txt: "📄", toml: "⚙️", yaml: "⚙️", yml: "⚙️" };
        return icons[ext] || "📄";
    }

    var CodePanel = {
        sessionId: null, projectName: null, currentFile: null, editor: null,
        monacoReady: false, isVisible: false, terminalBuffer: "", attribution: {}, _pendingFile: null,

        open: function(data) {
            this.sessionId = data.sessionId;
            this.projectName = data.projectName || "project";
            this.attribution = data.attribution || {};
            var nameEl = document.getElementById("code-panel-project-name");
            if (nameEl) nameEl.textContent = this.projectName;
            if (data.type === "code_run") {
                this._showPanel();
                this._openTerminal();
                this._startRunStream(data.entryFile || "index.js");
                return;
            }
            this._showPanel();
            this._refreshFileTree(data.files || null);
            this._initMonaco();
        },

        reopen: function() {
            if (!this.sessionId) return;
            this._showPanel();
            this._refreshFileTree(null);
            if (this.monacoReady && this.editor && this.currentFile) this._highlightTreeItem(this.currentFile);
        },

        close: function() {
            var panel = document.getElementById("code-panel");
            if (panel) { panel.style.display = "none"; panel.classList.add("hidden"); }
            var main = document.getElementById("main");
            if (main) main.classList.remove("code-panel-open");
            this.isVisible = false;
            if (this.sessionId) {
                var btn = document.getElementById("code-reopen-btn");
                if (btn) { btn.classList.remove("hidden"); btn.title = "Reopen editor: " + this.projectName; btn.textContent = "</> " + this.projectName; }
                fetch("/api/code/abort/" + encodeURIComponent(this.sessionId), { method: "POST" }).catch(function() {});
            }
        },

        _showPanel: function() {
            var panel = document.getElementById("code-panel");
            if (panel) { panel.style.display = "flex"; panel.classList.remove("hidden"); }
            var main = document.getElementById("main");
            if (main) main.classList.add("code-panel-open");
            this.isVisible = true;
            var btn = document.getElementById("code-reopen-btn");
            if (btn) btn.classList.add("hidden");
        },

        _refreshFileTree: function(files) {
            var self = this;
            if (files) {
                this._renderFileTree(files);
                if (!this.currentFile) {
                    var first = files.find(function(f) { return f.type === "file"; });
                    if (first) setTimeout(function() { self.loadFile(first.path); }, 600);
                }
                return;
            }
            if (!this.sessionId) return;
            fetch("/api/code/session/" + encodeURIComponent(this.sessionId))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    self._renderFileTree(data.files || []);
                    if (!self.currentFile) {
                        var first = (data.files || []).find(function(f) { return f.type === "file"; });
                        if (first) setTimeout(function() { self.loadFile(first.path); }, 600);
                    } else self._highlightTreeItem(self.currentFile);
                })
                .catch(function(err) { console.error("[CodePanel] File tree fetch failed:", err); });
        },

        _renderFileTree: function(files) {
            var container = document.getElementById("code-file-tree");
            if (!container) return;
            container.innerHTML = "";
            if (!files || files.length === 0) { container.innerHTML = '<div style="color:#4b5563;font-size:11px;padding:8px">No files</div>'; return; }
            var root = {};
            files.slice().sort(function(a, b) { return a.path.localeCompare(b.path); }).forEach(function(item) {
                var parts = item.path.replace(/\\/g, "/").split("/");
                var node = root;
                parts.forEach(function(part, i) {
                    if (!part) return;
                    if (!node[part]) node[part] = { _meta: { type: i === parts.length - 1 ? item.type : "directory", fullPath: parts.slice(0, i + 1).join("/") } };
                    node = node[part];
                });
            });
            var self = this;
            function renderNode(node, name, depth, parentEl) {
                var meta = node._meta;
                if (!meta) return;
                var indent = depth * 14 + 8;
                var el = document.createElement("div");
                if (meta.type === "directory") {
                    el.style.cssText = "display:flex;align-items:center;gap:5px;padding:3px 6px 3px " + indent + "px;color:#6b7280;font-size:11.5px;font-weight:500;cursor:pointer;user-select:none;border-radius:4px";
                    el.innerHTML = '<span class="tree-arrow" style="font-size:9px;width:10px;display:inline-block;transition:transform 0.15s">▶</span><span>📁</span><span>' + escapeHtml(name) + '</span>';
                    parentEl.appendChild(el);
                    var childContainer = document.createElement("div");
                    parentEl.appendChild(childContainer);
                    var childKeys = Object.keys(node).filter(function(k) { return k !== "_meta"; });
                    var dirs = childKeys.filter(function(k) { return node[k]._meta && node[k]._meta.type === "directory"; }).sort();
                    var filesOnly = childKeys.filter(function(k) { return node[k]._meta && node[k]._meta.type !== "directory"; }).sort();
                    dirs.concat(filesOnly).forEach(function(childName) { renderNode(node[childName], childName, depth + 1, childContainer); });
                    var arrow = el.querySelector(".tree-arrow");
                    el.onclick = function() {
                        var hidden = childContainer.style.display === "none";
                        childContainer.style.display = hidden ? "" : "none";
                        if (arrow) arrow.style.transform = hidden ? "rotate(90deg)" : "rotate(0deg)";
                    };
                    if (arrow) arrow.style.transform = "rotate(90deg)";
                } else {
                    el.className = "code-tree-file";
                    el.dataset.path = meta.fullPath;
                    el.style.cssText = "display:flex;align-items:center;gap:5px;padding:3px 6px 3px " + indent + "px;color:#9ca3af;font-size:11.5px;cursor:pointer;user-select:none;border-radius:4px;transition:background 0.1s,color 0.1s";
                    el.innerHTML = '<span style="width:10px;display:inline-block;opacity:0.3;font-size:9px">•</span><span>' + getFileIcon(name) + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(name) + '</span>';
                    el.onmouseenter = function() { if (self.currentFile !== meta.fullPath) el.style.background = "rgba(255,255,255,0.04)"; };
                    el.onmouseleave = function() { if (self.currentFile !== meta.fullPath) el.style.background = ""; };
                    el.onclick = function() { self.loadFile(meta.fullPath); };
                    parentEl.appendChild(el);
                }
            }
            var topKeys = Object.keys(root);
            var topDirs = topKeys.filter(function(k) { return root[k]._meta && root[k]._meta.type === "directory"; }).sort();
            var topFiles = topKeys.filter(function(k) { return root[k]._meta && root[k]._meta.type !== "directory"; }).sort();
            topDirs.concat(topFiles).forEach(function(name) { renderNode(root[name], name, 0, container); });
        },

        _highlightTreeItem: function(filePath) {
            document.querySelectorAll(".code-tree-file").forEach(function(el) {
                var active = el.dataset.path === filePath;
                el.style.background = active ? "rgba(124,106,247,0.15)" : "";
                el.style.color = active ? "#e0e7ff" : "#9ca3af";
            });
        },

        _initMonaco: function() {
            if (this.monacoReady && this.editor) return;
            var container = document.getElementById("monaco-editor-container");
            if (!container) { console.warn("[CodePanel] monaco-editor-container not found"); return; }
            var self = this;
            require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" } });
            require(["vs/editor/editor.main"], function() {
                if (monaco.languages.json && monaco.languages.json.jsonDefaults) monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, enableSchemaRequest: false, schemas: [] });
                if (monaco.languages.typescript) {
                    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
                    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
                }
                self.editor = monaco.editor.create(container, { value: "", language: "javascript", theme: "vs-dark", fontSize: 13, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, wordWrap: "on", lineNumbers: "on", renderWhitespace: "none", padding: { top: 8 } });
                self.monacoReady = true;
                self.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() { self.saveCurrentFile(); });
                if (self._pendingFile) { var file = self._pendingFile; self._pendingFile = null; self.loadFile(file); }
            });
        },

        loadFile: function(filePath) {
            if (!this.sessionId) return;
            if (!this.monacoReady || !this.editor) { this._pendingFile = filePath; return; }
            this.currentFile = filePath;
            this._highlightTreeItem(filePath);
            this._renderAttribution(filePath);
            var tab = document.getElementById("code-current-tab");
            if (tab) tab.textContent = filePath.split("/").pop();
            var self = this;
            fetch("/api/code/file?sessionId=" + encodeURIComponent(this.sessionId) + "&filePath=" + encodeURIComponent(filePath))
                .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
                .then(function(data) {
                    var content = data.content || "";
                    var ext = (filePath.split(".").pop() || "").toLowerCase();
                    var langMap = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", json: "json", md: "markdown", html: "html", css: "css", sh: "shell", env: "plaintext", txt: "plaintext", toml: "ini", yaml: "yaml", yml: "yaml" };
                    var uri = monaco.Uri.parse("inmemory://project/" + filePath);
                    var model = monaco.editor.getModel(uri);
                    if (model) { if (model.getValue() !== content) model.setValue(content); self.editor.setModel(model); }
                    else self.editor.setModel(monaco.editor.createModel(content, langMap[ext] || "plaintext", uri));
                    self.editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
                })
                .catch(function(err) {
                    console.error("[CodePanel] Failed to load", filePath, err);
                    self.editor.setModel(monaco.editor.createModel("// Error loading file: " + err.message, "plaintext", monaco.Uri.parse("inmemory://project/" + filePath + "_error")));
                });
        },

        saveCurrentFile: function() {
            if (!this.currentFile || !this.sessionId || !this.editor) return;
            var indicator = document.getElementById("code-save-indicator");
            fetch("/api/code/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, filePath: this.currentFile, content: this.editor.getValue() }) })
                .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); if (indicator) { indicator.textContent = "Saved ✓"; indicator.style.color = "#4ade80"; setTimeout(function() { indicator.textContent = ""; }, 1500); } })
                .catch(function(err) { if (indicator) { indicator.textContent = "Save failed"; indicator.style.color = "#f87171"; setTimeout(function() { indicator.textContent = ""; }, 2000); } console.error("[CodePanel] Save failed:", err); });
        },

        run: function(entryFile) { this._clearTerminal(); this._openTerminal(); this._startRunStream(entryFile || "index.js"); },
        _startRunStream: function(entryFile) {
            if (!this.sessionId) return;
            var self = this;
            this._appendTerminal("$ node " + entryFile + "\n");
            fetch("/api/code/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, entryFile: entryFile }) }).then(function(response) {
                var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "";
                function pump() { return reader.read().then(function(chunk) { if (chunk.done) { self._appendTerminal("\n[Done]"); return; } buffer += decoder.decode(chunk.value, { stream: true }); var events = buffer.split("\n\n"); buffer = events.pop(); events.forEach(function(event) { var line = event.split("\n").find(function(l) { return l.startsWith("data: "); }); if (!line) return; try { var payload = JSON.parse(line.slice(6)); if (payload.type === "stdout") self._appendTerminal(payload.data); if (payload.type === "stderr") self._appendTerminal(payload.data); if (payload.type === "error") self._appendTerminal("\n[Error]: " + payload.data); if (payload.type === "exit") self._appendTerminal("\n[Exit code: " + payload.code + "]"); } catch (_) {} }); return pump(); }); }
                return pump();
            }).catch(function(err) { self._appendTerminal("\n[Connection error]: " + err.message); });
        },
        abort: function() { if (!this.sessionId) return; fetch("/api/code/abort/" + encodeURIComponent(this.sessionId), { method: "POST" }).catch(function() {}); this._appendTerminal("\n[Aborted]"); },
        downloadZip: function() { if (this.sessionId) window.location.href = "/api/code/zip/" + encodeURIComponent(this.sessionId); },
        saveToLocal: function() { if (!this.sessionId) return; fetch("/api/code/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId }) }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) alert("Saved to: " + d.savedTo); else alert("Save failed: " + d.error); }).catch(function(err) { alert("Error: " + err.message); }); },

        _renderAttribution: function(filePath) {
            var container = document.getElementById("code-attribution");
            if (!container) return;
            var attributions = this.attribution[filePath] || [];
            if (!attributions.length) { container.innerHTML = '<span style="color:#374151;font-size:10px;font-family:monospace">no rag sources</span>'; return; }
            container.innerHTML = attributions.map(function(a) { var simNum = parseFloat(String(a.similarity || "0").replace("%", "")); var simColor = simNum >= 50 ? "#4ade80" : simNum >= 30 ? "#facc15" : "#9ca3af"; return '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(124,106,247,0.08);border:1px solid rgba(124,106,247,0.2);border-radius:9999px;padding:1px 8px;font-size:10px;font-family:monospace;cursor:help;color:#a5b4fc" title="' + escapeHtml(String(a.preview || "")) + '">📚 <span style="color:#7c6af7">' + escapeHtml(String(a.table || "db")) + '</span>&nbsp;<span style="color:' + simColor + '">' + escapeHtml(String(a.similarity || "")) + '</span></span>'; }).join(" ");
        },
        _clearTerminal: function() { this.terminalBuffer = ""; var t = document.getElementById("code-terminal"); if (t) t.textContent = ""; },
        _openTerminal: function() { var p = document.getElementById("code-terminal-panel"); if (p) p.classList.remove("hidden"); },
        _appendTerminal: function(text) { var t = document.getElementById("code-terminal"); if (!t) return; this.terminalBuffer += text; if (this.terminalBuffer.length > 8192) this.terminalBuffer = "[…truncated]\n" + this.terminalBuffer.slice(-7500); t.textContent = this.terminalBuffer; t.scrollTop = t.scrollHeight; }
    };

    window.CodePanel = CodePanel;
})();
