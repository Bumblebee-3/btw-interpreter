(function () {
    "use strict";

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function (char) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
        });
    }

    var DocumentPanel = {
        currentResource: null,
        currentTab: "preview",
        editors: [],

        open: function (resource) {
            this.currentResource = resource;
            this.currentTab = "preview";
            var panel = document.getElementById("document-panel");
            if (panel) { panel.style.display = "flex"; panel.classList.remove("hidden"); }
            var title = document.getElementById("doc-panel-title");
            var format = document.getElementById("doc-panel-format");
            if (title) title.textContent = resource.title || "Document";
            if (format) format.textContent = String(resource.type || "document").toUpperCase();
            this.switchTab("preview");
        },
        close: function () {
            this.editors.forEach(function (editor) { try { editor.dispose(); } catch (_) {} });
            this.editors = [];
            var panel = document.getElementById("document-panel");
            if (panel) { panel.style.display = "none"; panel.classList.add("hidden"); }
            this.currentResource = null;
        },
        switchTab: function (tab) {
            this.currentTab = tab;
            ["preview", "edit", "sources"].forEach(function (name) {
                var button = document.getElementById("doc-tab-" + name);
                var pane = document.getElementById("doc-pane-" + name);
                if (button) button.style.borderBottomColor = name === tab ? "#7c6af7" : "transparent";
                if (pane) pane.style.display = name === tab ? "flex" : "none";
            });
            if (tab === "preview") this.renderPreview();
            if (tab === "edit") this.renderEdit();
            if (tab === "sources") this.renderSources();
        },
        renderPreview: function () {
            var resource = this.currentResource;
            var pane = document.getElementById("doc-pane-preview");
            if (!resource || !pane) return;
            var data = resource.data || {};
            var url = data.downloadUrl || (data.sessionId ? "/api/report/download/" + encodeURIComponent(data.sessionId) : "");
            if (resource.type === "pdf" || resource.type === "report") pane.innerHTML = '<iframe title="PDF preview" src="' + escapeHtml(url) + '" style="border:0;flex:1;width:100%"></iframe>';
            else if (resource.type === "docx") pane.innerHTML = '<div style="padding:24px;color:#9ca3af">DOCX is ready to download. Use the Download button above.</div>';
            else {
                var markdown = (resource.sections || []).map(function (section) { return "## " + section.heading + "\n\n" + section.content; }).join("\n\n---\n\n");
                pane.innerHTML = '<div class="assistant-content" style="overflow:auto;padding:32px;max-width:900px;width:100%;margin:auto">' + (window.marked ? marked.parse(markdown) : "<pre>" + escapeHtml(markdown) + "</pre>") + "</div>";
            }
        },
        renderEdit: function () {
            var resource = this.currentResource;
            var pane = document.getElementById("doc-pane-edit");
            if (!resource || !pane) return;
            var sections = resource.sections || [];
            if (!sections.length) { pane.innerHTML = '<div style="padding:24px;color:#6b7280">No editable sections available.</div>'; return; }
            this.editors.forEach(function (editor) { try { editor.dispose(); } catch (_) {} });
            this.editors = [];
            pane.innerHTML = '<div style="padding:10px 16px;border-bottom:1px solid #2a2a2a"><button id="doc-regenerate-pdf" style="background:#7c6af7;color:white;border:0;border-radius:6px;padding:5px 10px;cursor:pointer">Regenerate PDF</button> <button id="doc-regenerate-docx" style="background:#2563eb;color:white;border:0;border-radius:6px;padding:5px 10px;cursor:pointer">Regenerate DOCX</button></div>' + sections.map(function (section, index) { return '<div style="border-bottom:1px solid #2a2a2a"><div style="padding:8px 16px;color:#d1d5db;font-size:12px">' + escapeHtml(section.heading) + '</div><div id="doc-editor-' + index + '" style="height:150px"></div></div>'; }).join("");
            var self = this;
            document.getElementById("doc-regenerate-pdf").onclick = function () { self.regenerate("pdf"); };
            document.getElementById("doc-regenerate-docx").onclick = function () { self.regenerate("docx"); };
            setTimeout(function () {
                if (!window.monaco) return;
                sections.forEach(function (section, index) {
                    var container = document.getElementById("doc-editor-" + index);
                    if (!container) return;
                    var editor = monaco.editor.create(container, { value: section.content || "", language: "markdown", theme: "vs-dark", minimap: { enabled: false }, lineNumbers: "off", wordWrap: "on", automaticLayout: true });
                    self.editors.push(editor);
                });
            }, 50);
        },
        regenerate: function (format) {
            var resource = this.currentResource;
            if (!resource || !resource.data || !resource.data.sessionId) return;
            var sections = (resource.sections || []).map(function (section, index) { return { heading: section.heading, content: window.DocumentPanel.editors[index] ? window.DocumentPanel.editors[index].getValue() : section.content }; });
            var status = document.getElementById("doc-panel-status");
            if (status) status.textContent = "Regenerating...";
            fetch("/api/report/regenerate/" + encodeURIComponent(resource.data.sessionId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sections: sections, format: format, title: resource.title }) }).then(function (response) { return response.json(); }).then(function (result) {
                if (!result.ok) throw new Error(result.error || "Regeneration failed");
                resource.sections = sections;
                resource.data.downloadUrl = result.downloadUrl;
                resource.type = format === "docx" ? "docx" : "pdf";
                if (status) status.textContent = "Done";
                window.DocumentPanel.switchTab("preview");
            }).catch(function (error) { if (status) status.textContent = error.message; });
        },
        renderSources: function () {
            var pane = document.getElementById("doc-pane-sources");
            var sources = (this.currentResource && this.currentResource.sources) || [];
            if (pane) pane.innerHTML = sources.length ? '<div style="padding:16px;overflow:auto">' + sources.map(function (source) { return '<div style="border:1px solid #2a2a2a;background:#111;border-radius:8px;padding:10px;margin-bottom:8px;color:#9ca3af;font-size:12px"><strong style="color:#a5b4fc">' + escapeHtml(source.table || source.title || source.type) + '</strong><br>' + escapeHtml(source.preview || source.snippet || source.url || "") + '</div>'; }).join("") + '</div>' : '<div style="padding:24px;color:#6b7280">No source attribution recorded.</div>';
        },
        download: function () {
            var resource = this.currentResource;
            var data = resource && resource.data;
            if (data && data.downloadUrl) window.location.href = data.downloadUrl;
        }
    };
    window.DocumentPanel = DocumentPanel;
})();
