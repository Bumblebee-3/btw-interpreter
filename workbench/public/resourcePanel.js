(function () {
    "use strict";

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function (char) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
        });
    }

    function timeAgo(timestamp) {
        var seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return "just now";
        if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
        return Math.floor(seconds / 86400) + "d ago";
    }

    var icons = { code_project: "💻", pdf: "📄", docx: "📝", markdown: "📋", report: "📊" };
    var ResourcePanel = {
        sessionId: null,
        resources: [],
        isOpen: false,

        init: function (sessionId) { this.sessionId = sessionId; this.resources = []; },
        loadFromServer: function (sessionId) {
            var self = this;
            if (sessionId) this.sessionId = sessionId;
            if (!this.sessionId) return Promise.resolve([]);
            return fetch("/api/resources/" + encodeURIComponent(this.sessionId))
                .then(function (response) { return response.ok ? response.json() : []; })
                .then(function (resources) {
                    self.resources = Array.isArray(resources) ? resources : [];
                    self._updateBadge();
                    if (self.isOpen) self._render();
                    return self.resources;
                }).catch(function () { return []; });
        },
        register: function (type, title, data, sources, sections, messageIndex) {
            var self = this;
            if (!this.sessionId) return Promise.resolve([]);
            return fetch("/api/resources/" + encodeURIComponent(this.sessionId), {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: type, title: title, data: data, sources: sources || [], sections: sections || [], messageIndex: messageIndex })
            }).then(function () { return self.loadFromServer(); }).catch(function () { return []; });
        },
        open: function () {
            var self = this;
            this.isOpen = true;
            var drawer = document.getElementById("resource-drawer");
            if (drawer) { drawer.classList.remove("translate-x-full"); drawer.classList.add("translate-x-0"); }
            this.loadFromServer().then(function () { self._render(); });
        },
        close: function () {
            this.isOpen = false;
            var drawer = document.getElementById("resource-drawer");
            if (drawer) { drawer.classList.add("translate-x-full"); drawer.classList.remove("translate-x-0"); }
        },
        toggle: function () { if (this.isOpen) this.close(); else this.open(); },
        _updateBadge: function () {
            var badge = document.getElementById("resource-count-badge");
            if (!badge) return;
            badge.textContent = this.resources.length ? String(this.resources.length) : "";
            badge.style.display = this.resources.length ? "inline-flex" : "none";
        },
        _render: function () {
            var body = document.getElementById("resource-drawer-body");
            if (!body) return;
            if (!this.resources.length) {
                body.innerHTML = '<div style="color:#6b7280;text-align:center;padding:40px 20px;font-size:13px">No files generated yet.</div>';
                return;
            }
            var self = this;
            body.innerHTML = this.resources.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).map(function (resource) {
                var sources = (resource.sources || []).length;
                return '<button class="resource-entry" data-id="' + escapeHtml(resource.id) + '" style="display:block;width:100%;text-align:left;color:#e5e7eb;background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer">' +
                    '<div style="display:flex;align-items:center;gap:8px"><span>' + (icons[resource.type] || "📦") + '</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + escapeHtml(resource.title) + '</span><span style="color:#6b7280;font-size:10px">' + timeAgo(resource.createdAt) + '</span></div>' +
                    '<div style="color:#6b7280;font-size:10px;margin-top:4px">' + escapeHtml(String(resource.type).replace("_", " ")) + (sources ? " · " + sources + " source" + (sources > 1 ? "s" : "") : "") + '</div></button>';
            }).join("");
            body.querySelectorAll(".resource-entry").forEach(function (element) {
                element.addEventListener("click", function () {
                    var resource = self.resources.find(function (item) { return item.id === element.dataset.id; });
                    if (!resource) return;
                    self.close();
                    if (resource.type === "code_project" && window.CodePanel) window.CodePanel.open(resource.data);
                    else if (window.DocumentPanel) window.DocumentPanel.open(resource);
                });
            });
        },
        getForMessage: function (messageIndex) { return this.resources.filter(function (item) { return item.messageIndex === messageIndex; }); }
    };
    window.ResourcePanel = ResourcePanel;
})();
