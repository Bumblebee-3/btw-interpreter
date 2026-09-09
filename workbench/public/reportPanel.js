// reportPanel.js — Report download/preview panel
// Loaded via script tag; attaches to window.ReportPanel

(function() {
    var ReportPanel = {
        sessionId: null,
        currentReport: null,

        open: function(data) {
            this.sessionId = data.sessionId;
            this.currentReport = data;

            var panel = document.getElementById("report-panel");
            if (panel) {
                panel.classList.remove("hidden");
                panel.classList.add("flex");
            }

            // Update panel content
            var titleEl = document.getElementById("report-panel-title");
            if (titleEl) titleEl.textContent = data.title || "Report";

            var formatEl = document.getElementById("report-panel-format");
            if (formatEl) formatEl.textContent = (data.format || "pdf").toUpperCase();

            var downloadBtn = document.getElementById("report-download-btn");
            if (downloadBtn) {
                downloadBtn.onclick = function() { ReportPanel.download(); };
            }

            // For PDFs, show an iframe preview
            if (data.format === "pdf") {
                var iframe = document.getElementById("report-pdf-preview");
                if (iframe) {
                    iframe.src = data.downloadUrl;
                    iframe.classList.remove("hidden");
                }
            }
        },

        download: function() {
            if (!this.currentReport) return;
            window.location.href = this.currentReport.downloadUrl;
        },

        close: function() {
            var panel = document.getElementById("report-panel");
            if (panel) {
                panel.classList.add("hidden");
                panel.classList.remove("flex");
            }
            var iframe = document.getElementById("report-pdf-preview");
            if (iframe) {
                iframe.src = "";
                iframe.classList.add("hidden");
            }
        }
    };

    window.ReportPanel = ReportPanel;
})();