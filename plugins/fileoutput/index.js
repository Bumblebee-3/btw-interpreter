"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } = require("docx");

// Module-level map: sessionId → { filePath, format, title }
const lastReports = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function buildPanelPayload(type, data) {
    return `__PANEL_START__${JSON.stringify({ type, ...data })}__PANEL_END__\n\n`;
}

function normalizeFormat(raw) {
    const f = String(raw || "pdf").toLowerCase().trim();
    if (f.includes("word") || f.includes("docx") || f.includes("doc")) return "docx";
    return "pdf";
}

function normalizeDataSources(raw) {
    const s = String(raw || "all").toLowerCase();
    if (s === "rag") return ["rag"];
    if (s === "chat" || s === "chat_history" || s === "history") return ["chat_history"];
    if (s === "web") return ["web"];
    return ["rag", "chat_history", "web"];
}

// ─── Data collection ──────────────────────────────────────────────────────────

async function collectRAGData(topic, obj) {
    if (!obj.db || !obj.db.dbPath) return [];
    try {
        const results = await obj.db.searchDB(topic, 15, obj.table_config);
        return (results || []).filter(r =>
            parseFloat(String(r.similarity || "0").replace("%", "")) >= 20
        ).map(r => r.text);
    } catch (_) { return []; }
}

async function collectChatHistory(obj) {
    if (!obj.messageHistory) return [];
    const history = obj.messageHistory.getAll();
    return history.map(turn => {
        const parts = [];
        if (turn.userQuery) parts.push(`User: ${turn.userQuery}`);
        if (turn.llmFormattedResult) {
            const text = typeof turn.llmFormattedResult === "string"
                ? turn.llmFormattedResult
                : turn.llmFormattedResult.content || JSON.stringify(turn.llmFormattedResult);
            parts.push(`Assistant: ${text.slice(0, 1000)}`);
        }
        return parts.join("\n");
    });
}

async function collectWebData(topic, obj) {
    // Use Tavily plugin if loaded
    const tavilyPlugin = (obj.plugins || []).find(p =>
        String(p?.data?.name || "").toLowerCase() === "tavily"
    );
    if (!tavilyPlugin) return [];

    try {
        const { loadPlugin } = require("../../src/interpreter/pluginHandler.js");
        const tavily = loadPlugin(tavilyPlugin, tavilyPlugin.params);
        const result = await tavily.searchOnline(topic);
        return [String(result || "").replace(/LINK:\[.*?\]/g, "").trim()];
    } catch (_) { return []; }
}

// ─── Report structure planning ────────────────────────────────────────────────

async function planReportStructure(topic, title, collectedData, additionalInstructions, obj) {
    const dataPreview = collectedData.slice(0, 6).join("\n\n---\n\n").slice(0, 4000);

    const prompt = `You are a professional report writer. Plan the structure of a report about: "${topic}"
Report title: "${title}"
${additionalInstructions ? `Additional instructions: ${additionalInstructions}` : ""}

Available data (preview):
${dataPreview || "(No data available — use general knowledge)"}

Return ONLY valid JSON:
{
  "sections": [
    {
      "heading": "Section heading",
      "content_instructions": "What to write in this section. Be specific. 2-3 sentences.",
      "data_relevant": true
    }
  ]
}

Rules:
- Include 4-8 sections
- First section should be an Executive Summary
- Last section should be a Conclusion
- Headings should be professional and descriptive
- Mark data_relevant=true only for sections that should use the provided data`;

    try {
        const raw = await obj.customQuery(prompt);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) throw new Error("no JSON");
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed.sections)) throw new Error("no sections");
        return parsed.sections;
    } catch (_) {
        return [
            { heading: "Executive Summary", content_instructions: `Brief overview of ${topic}`, data_relevant: true },
            { heading: "Main Content", content_instructions: `Detailed information about ${topic}`, data_relevant: true },
            { heading: "Conclusion", content_instructions: `Summary and key takeaways about ${topic}`, data_relevant: false }
        ];
    }
}

// Generate text content for a single section
async function generateSectionContent(section, relevantData, topic, obj) {
    const dataBlock = section.data_relevant && relevantData.length > 0
        ? `\nUse this data as the primary source:\n${relevantData.slice(0, 4).join("\n\n").slice(0, 3000)}\n`
        : "";

    const prompt = `Write the "${section.heading}" section of a professional report about "${topic}".

Instructions for this section: ${section.content_instructions}
${dataBlock}
Rules:
- Write 2-5 paragraphs of professional, clear prose
- Do NOT use markdown formatting (no #, *, -, backticks)
- Do NOT include the section heading in your output
- Be factual, concise, and well-structured
- If using provided data, cite it naturally in the text`;

    const content = await obj.customQuery(prompt);
    return String(content || "").trim();
}

// ─── PDF generation ───────────────────────────────────────────────────────────

async function generatePDF(title, sections, outputPath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            margins: { top: 72, bottom: 72, left: 72, right: 72 },
            info: { Title: title, Author: "BTW Assistant", Creator: "BTW FileOutput Plugin" }
        });

        const stream = fs.createWriteStream(outputPath);
        stream.on("finish", resolve);
        stream.on("error", reject);
        doc.pipe(stream);

        // ── Cover page ──
        doc.fontSize(28).font("Helvetica-Bold").text(title, { align: "center" });
        doc.moveDown(0.5);
        doc.fontSize(12).font("Helvetica").fillColor("#666666")
            .text(`Generated by BTW Assistant · ${new Date().toLocaleDateString()}`, { align: "center" });
        doc.fillColor("#000000");
        doc.moveDown(2);
        doc.moveTo(72, doc.y).lineTo(doc.page.width - 72, doc.y).stroke();
        doc.moveDown(2);

        // ── Table of contents ──
        doc.fontSize(16).font("Helvetica-Bold").text("Table of Contents");
        doc.moveDown(0.5);
        sections.forEach((s, i) => {
            doc.fontSize(11).font("Helvetica").text(`${i + 1}. ${s.heading}`, { indent: 10 });
        });
        doc.addPage();

        // ── Sections ──
        sections.forEach((s, i) => {
            if (i > 0) doc.addPage();
            doc.fontSize(18).font("Helvetica-Bold").text(s.heading);
            doc.moveDown(0.5);
            doc.moveTo(72, doc.y).lineTo(doc.page.width - 72, doc.y).strokeColor("#cccccc").stroke();
            doc.strokeColor("#000000");
            doc.moveDown(0.5);
            doc.fontSize(11).font("Helvetica").text(s.content || "", {
                align: "justify",
                lineGap: 4
            });
        });

        doc.end();
    });
}

// ─── DOCX generation ──────────────────────────────────────────────────────────

async function generateDOCX(title, sections, outputPath) {
    const docChildren = [];

    // Title paragraph
    docChildren.push(new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER
    }));

    docChildren.push(new Paragraph({
        children: [new TextRun({
            text: `Generated by BTW Assistant · ${new Date().toLocaleDateString()}`,
            color: "666666",
            size: 22
        })],
        alignment: AlignmentType.CENTER
    }));

    docChildren.push(new Paragraph({ children: [new PageBreak()] }));

    // Sections
    sections.forEach(s => {
        docChildren.push(new Paragraph({
            text: s.heading,
            heading: HeadingLevel.HEADING_1
        }));

        const paragraphs = String(s.content || "").split(/\n{2,}/);
        paragraphs.forEach(para => {
            if (para.trim()) {
                docChildren.push(new Paragraph({
                    children: [new TextRun({ text: para.trim(), size: 24 })],
                    spacing: { after: 200 }
                }));
            }
        });
    });

    const doc = new Document({
        sections: [{ properties: {}, children: docChildren }],
        title,
        creator: "BTW Assistant"
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);
}

// ─── Plugin Class ─────────────────────────────────────────────────────────────

class FileOutput {
    constructor(output_dir, credentials_path, token_path, obj) {
        this.outputDir = output_dir || path.join(os.tmpdir(), "btw-reports");
        this.credentialsPath = credentials_path || "";
        this.tokenPath = token_path || "";
        this.obj = obj;
        ensureDir(this.outputDir);
    }

    _getSessionId() {
        return String(this.obj.sessionId || "default");
    }

    // ── generateReportWorkflow ─────────────────────────────────────────────────

    async generateReportWorkflow(params, context) {
        const topic = String(params.report_topic || "").trim();
        if (!topic) {
            return { status: "needs_input", field: "report_topic", message: "What should the report cover?" };
        }

        const format = normalizeFormat(params.output_format);
        const sources = normalizeDataSources(params.data_sources);
        const title = String(params.report_title || topic).trim();
        const additionalInstructions = String(params.additional_instructions || "").trim();
        const sessionId = this._getSessionId();
        const sessionOutputDir = path.join(this.outputDir, sessionId);
        ensureDir(sessionOutputDir);

        const timestamp = Date.now();
        const filename = `report_${timestamp}.${format}`;
        const outputPath = path.join(sessionOutputDir, filename);

        // Step 1: Collect data from selected sources
        const allData = [];
        if (sources.includes("rag")) {
            const ragData = await collectRAGData(topic, this.obj);
            allData.push(...ragData);
        }
        if (sources.includes("chat_history")) {
            const chatData = await collectChatHistory(this.obj);
            allData.push(...chatData);
        }
        if (sources.includes("web")) {
            const webData = await collectWebData(topic, this.obj);
            allData.push(...webData);
        }

        // Step 2: Plan report structure
        let sections;
        try {
            sections = await planReportStructure(topic, title, allData, additionalInstructions, this.obj);
        } catch (err) {
            return `Failed to plan report structure: ${err.message}`;
        }

        // Step 3: Generate content for each section
        for (const section of sections) {
            try {
                section.content = await generateSectionContent(section, allData, topic, this.obj);
            } catch (_) {
                section.content = `Content for this section could not be generated.`;
            }
        }

        // Step 4: Write the file
        try {
            if (format === "pdf") {
                await generatePDF(title, sections, outputPath);
            } else {
                await generateDOCX(title, sections, outputPath);
            }
        } catch (err) {
            return `Failed to generate ${format.toUpperCase()} file: ${err.message}`;
        }

        // Store for email workflow
        lastReports.set(sessionId, { filePath: outputPath, format, title, filename });

        const downloadUrl = `/api/report/download/${sessionId}`;
        const panelPayload = buildPanelPayload("report", {
            format,
            filename,
            sessionId,
            downloadUrl,
            title
        });

        const sourceList = sources.join(", ");
        return [
            panelPayload,
            `## 📄 Report Generated`,
            "",
            `**Title:** ${title}`,
            `**Format:** ${format.toUpperCase()}`,
            `**Data sources used:** ${sourceList}`,
            `**Sections:** ${sections.map(s => s.heading).join(" → ")}`,
            "",
            "_Your report is ready. Use the download button in the panel, or ask me to email it._"
        ].join("\n");
    }

    // ── emailReportWorkflow ────────────────────────────────────────────────────

    async emailReportWorkflow(params, context) {
        const sessionId = this._getSessionId();
        const reportMeta = lastReports.get(sessionId);

        if (!reportMeta || !fs.existsSync(reportMeta.filePath)) {
            return "No report has been generated yet. Generate a report first, then ask me to email it.";
        }

        const recipient = String(params.recipient || "").trim();
        if (!recipient) {
            return { status: "needs_input", field: "recipient", message: "Who should I send the report to?" };
        }

        const gmailPlugin = (this.obj.plugins || []).find(p =>
            String(p?.data?.name || "").toLowerCase() === "gmail"
        );
        if (!gmailPlugin) {
            return `Report is at \`${reportMeta.filePath}\`. Gmail plugin is not loaded — attach it manually.`;
        }

        try {
            const { loadPlugin } = require("../../src/interpreter/pluginHandler.js");
            const gmailInstance = loadPlugin(gmailPlugin, gmailPlugin.params);
            const fileBuffer = fs.readFileSync(reportMeta.filePath);
            const base64File = fileBuffer.toString("base64");
            const mimeType = reportMeta.format === "pdf"
                ? "application/pdf"
                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

            const subject = `Report: ${reportMeta.title}`;
            const body = String(params.message || `Please find the report "${reportMeta.title}" attached.`);

            return await gmailInstance.sendEmailWorkflow({
                recipient,
                subject,
                body,
                attachment: {
                    mimeType,
                    filename: reportMeta.filename,
                    base64: base64File
                }
            }, context);
        } catch (err) {
            return `Failed to send report: ${err.message}`;
        }
    }
}

// Export lastReports for use by reportRouter
FileOutput._lastReports = lastReports;

module.exports = FileOutput;