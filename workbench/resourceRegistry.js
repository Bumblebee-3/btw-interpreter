"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const dataDir = path.join(__dirname, "data");

function registryPath(sessionId) {
    return path.join(dataDir, "resources_" + String(sessionId) + ".json");
}

function load(sessionId) {
    try {
        const filePath = registryPath(sessionId);
        if (!fs.existsSync(filePath)) return [];
        const entries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return Array.isArray(entries) ? entries : [];
    } catch (_) {
        return [];
    }
}

function save(sessionId, resources) {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = registryPath(sessionId);
    const temporaryPath = filePath + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(resources, null, 2));
    fs.renameSync(temporaryPath, filePath);
}

router.clearSession = function (sessionId) {
    const filePath = registryPath(sessionId);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
};

router.get("/:sessionId", (req, res) => res.json(load(req.params.sessionId)));

router.post("/:sessionId", express.json({ limit: "1mb" }), (req, res) => {
    const resource = req.body || {};
    if (!resource.type) return res.status(400).json({ error: "type required" });
    const entry = {
        id: crypto.randomUUID(),
        type: resource.type,
        title: resource.title || "Untitled",
        createdAt: Date.now(),
        messageIndex: typeof resource.messageIndex === "number" ? resource.messageIndex : -1,
        data: resource.data || {},
        sources: Array.isArray(resource.sources) ? resource.sources : [],
        sections: Array.isArray(resource.sections) ? resource.sections : []
    };
    const registry = load(req.params.sessionId).filter(item =>
        !(item.messageIndex === entry.messageIndex && item.type === entry.type && entry.messageIndex >= 0)
    );
    registry.push(entry);
    save(req.params.sessionId, registry);
    res.json({ id: entry.id, ok: true });
});

router.delete("/:sessionId/:resourceId", (req, res) => {
    save(req.params.sessionId, load(req.params.sessionId).filter(item => item.id !== req.params.resourceId));
    res.json({ ok: true });
});

module.exports = router;
