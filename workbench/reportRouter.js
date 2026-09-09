"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

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

module.exports = router;