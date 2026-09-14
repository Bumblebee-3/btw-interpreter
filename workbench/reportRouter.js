"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

const router = express.Router();

function getFileOutput() {
    try { return require("../plugins/fileoutput/index.js"); } catch (_) { return null; }
}

// GET /api/report/latest/:sessionId — get metadata about the latest report
router.get("/latest/:sessionId", (req, res) => {
    const FileOutput = getFileOutput();
    if (!FileOutput) return res.status(503).json({ error: "FileOutput plugin not loaded" });

    const meta = FileOutput._lastReports.get(req.params.sessionId);
    if (!meta) return res.status(404).json({ error: "No report generated for this session" });

    res.json({
        filename: meta.filename,
        format: meta.format,
        title: meta.title,
        exists: fs.existsSync(meta.filePath)
    });
});

// GET /api/report/download/:sessionId — download the report file
router.get("/download/:sessionId", (req, res) => {
    const FileOutput = getFileOutput();
    if (!FileOutput) return res.status(503).json({ error: "FileOutput plugin not loaded" });

    const meta = FileOutput._lastReports.get(req.params.sessionId);
    if (!meta || !fs.existsSync(meta.filePath)) {
        return res.status(404).json({ error: "Report file not found" });
    }

    const mimeType = meta.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
    res.setHeader("Content-Type", mimeType);
    fs.createReadStream(meta.filePath).pipe(res);
});

router.post("/regenerate/:sessionId", express.json({ limit: "2mb" }), async (req, res) => {
    const { sections, format, title } = req.body || {};
    if (!Array.isArray(sections)) return res.status(400).json({ error: "sections array required" });
    const outputDir = path.join(os.tmpdir(), "btw-reports", req.params.sessionId);
    fs.mkdirSync(outputDir, { recursive: true });
    const normalizedFormat = String(format || "pdf").toLowerCase().includes("docx") ? "docx" : "pdf";
    const filename = "report_" + Date.now() + "." + normalizedFormat;
    const outputPath = path.join(outputDir, filename);
    try {
        if (normalizedFormat === "pdf") await generatePDFFromSections(title || "Report", sections, outputPath);
        else await generateDOCXFromSections(title || "Report", sections, outputPath);
        const FileOutput = getFileOutput();
        const existing = FileOutput?._lastReports.get(req.params.sessionId);
        if (existing) Object.assign(existing, { filePath: outputPath, filename, format: normalizedFormat, sections });
        res.json({ ok: true, downloadUrl: "/api/report/download/" + req.params.sessionId, filename, format: normalizedFormat });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function generatePDFFromSections(title, sections, outputPath) {
    return new Promise((resolve, reject) => {
        const document = new PDFDocument({ margins: { top: 72, bottom: 72, left: 72, right: 72 } });
        const stream = fs.createWriteStream(outputPath);
        stream.on("finish", resolve);
        stream.on("error", reject);
        document.pipe(stream);
        document.fontSize(24).font("Helvetica-Bold").text(title, { align: "center" }).moveDown(2);
        sections.forEach((section, index) => {
            if (index > 0) document.addPage();
            document.fontSize(16).font("Helvetica-Bold").text(section.heading || "Section").moveDown(0.5);
            document.fontSize(11).font("Helvetica").text(section.content || "", { align: "justify", lineGap: 4 });
        });
        document.end();
    });
}

async function generateDOCXFromSections(title, sections, outputPath) {
    const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
    sections.forEach(section => {
        children.push(new Paragraph({ text: section.heading || "Section", heading: HeadingLevel.HEADING_1 }));
        String(section.content || "").split(/\n{2,}/).filter(Boolean).forEach(text => {
            children.push(new Paragraph({ children: [new TextRun({ text: text.trim(), size: 24 })], spacing: { after: 200 } }));
        });
    });
    fs.writeFileSync(outputPath, await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

module.exports = router;