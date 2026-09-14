"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const treeKill = require("tree-kill");

const router = express.Router();

let tempBaseDir = path.join(os.tmpdir(), "btw-codeagent");
router.setTempBaseDir = function (dir) {
    tempBaseDir = dir;
};

router.deleteSessionProject = function (sessionId) {
    const root = path.resolve(tempBaseDir);
    const sessionDir = path.resolve(root, String(sessionId || ""));
    if (sessionDir === root || !sessionDir.startsWith(`${root}${path.sep}`)) return false;

    const CodeAgent = getCodeAgent();
    if (CodeAgent) CodeAgent._sessions.delete(String(sessionId));
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    return true;
};

// Lazily get the CodeAgent session store after plugins are loaded
function getCodeAgent() {
    try { return require("../plugins/codeagent/index.js"); } catch (_) { return null; }
}

function sendSSE(res, data) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveProjectPath(projectDir, relativePath) {
    const root = path.resolve(projectDir);
    const resolved = path.resolve(root, String(relativePath || ""));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    return resolved;
}

function stopProcess(child) {
    if (!child) return;
    try {
        treeKill(child.pid);
    } catch (_) {
        try { child.kill("SIGTERM"); } catch (_) {}
    }
}

function walkDir(dirPath, baseDir) {
    const results = [];
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        if (entry.isDirectory()) {
            results.push({ path: relativePath, type: "directory" });
            results.push(...walkDir(fullPath, baseDir));
        } else {
            results.push({ path: relativePath, type: "file" });
        }
    }
    return results;
}

function getOrRecoverSession(sessionId) {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return null;
    const session = CodeAgent._sessions.get(sessionId);
    if (session && fs.existsSync(session.projectDir)) return session;
    const sessionFile = path.join(tempBaseDir, sessionId, "btw_session.json");
    if (!fs.existsSync(sessionFile)) return null;
    try {
        const recovered = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        if (!recovered.projectDir || !fs.existsSync(recovered.projectDir)) return null;
        CodeAgent._sessions.set(sessionId, recovered);
        return recovered;
    } catch (_) {
        return null;
    }
}

// GET /api/code/session/:sessionId — get project file tree
router.get("/session/:sessionId", (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const session = getOrRecoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "No project for this session" });

    const files = walkDir(session.projectDir, session.projectDir);
    res.json({
        projectName: session.projectName,
        projectDir: session.projectDir,
        files
    });
});

// GET /api/code/file?sessionId=...&filePath=...
router.get("/file", (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const { sessionId, filePath } = req.query;
    if (!sessionId || !filePath) return res.status(400).json({ error: "sessionId and filePath required" });

    const session = getOrRecoverSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Security: ensure filePath doesn't escape the project directory
    const fullPath = resolveProjectPath(session.projectDir, filePath);
    if (!fullPath) {
        return res.status(403).json({ error: "Path traversal not allowed" });
    }

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });

    try {
        const content = fs.readFileSync(fullPath, "utf-8");
        res.json({ content, filePath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/code/file — write file content from Monaco editor
router.put("/file", express.json({ limit: "2mb" }), (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const { sessionId, filePath, content } = req.body || {};
    if (!sessionId || !filePath || content === undefined) {
        return res.status(400).json({ error: "sessionId, filePath, and content required" });
    }

    const session = getOrRecoverSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const fullPath = resolveProjectPath(session.projectDir, filePath);
    if (!fullPath) {
        return res.status(403).json({ error: "Path traversal not allowed" });
    }

    try {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf-8");
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/code/run — SSE endpoint: runs node in project directory
router.post("/run", express.json(), (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const { sessionId, entryFile = "index.js" } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const session = getOrRecoverSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const safeEntry = String(entryFile).replace(/[^a-zA-Z0-9_\-./]/g, "");
    const entryPath = resolveProjectPath(session.projectDir, safeEntry);
    if (!entryPath || path.extname(entryPath).toLowerCase() !== ".js" || !fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
        return res.status(404).json({ error: `${safeEntry} not found in project` });
    }

    // Kill any existing process for this session
    const existing = CodeAgent._runningProcesses.get(sessionId);
    if (existing) {
        stopProcess(existing);
        CodeAgent._runningProcesses.delete(sessionId);
    }

    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.flushHeaders();

    sendSSE(res, { type: "start", entryFile: safeEntry });

    const child = spawn("node", [safeEntry], {
        cwd: session.projectDir,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: "development"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    CodeAgent._runningProcesses.set(sessionId, child);

    // Hard timeout: 30 seconds
    const timeout = setTimeout(() => {
        sendSSE(res, { type: "error", data: "\n[Process killed: 30s timeout exceeded]" });
        stopProcess(child);
        CodeAgent._runningProcesses.delete(sessionId);
        if (!res.writableEnded) res.end();
    }, 30000);

    child.stdout.on("data", chunk => {
        sendSSE(res, { type: "stdout", data: chunk.toString() });
    });

    child.stderr.on("data", chunk => {
        sendSSE(res, { type: "stderr", data: chunk.toString() });
    });

    child.on("close", code => {
        clearTimeout(timeout);
        CodeAgent._runningProcesses.delete(sessionId);
        sendSSE(res, { type: "exit", code });
        if (!res.writableEnded) res.end();
    });

    child.on("error", err => {
        clearTimeout(timeout);
        CodeAgent._runningProcesses.delete(sessionId);
        sendSSE(res, { type: "error", data: err.message });
        if (!res.writableEnded) res.end();
    });

    req.on("close", () => {
        clearTimeout(timeout);
        stopProcess(child);
        CodeAgent._runningProcesses.delete(sessionId);
    });
});

// POST /api/code/abort/:sessionId — kill running process
router.post("/abort/:sessionId", (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const child = CodeAgent._runningProcesses.get(req.params.sessionId);
    if (!child) return res.json({ ok: true, message: "No running process" });

    try {
        stopProcess(child);
        CodeAgent._runningProcesses.delete(req.params.sessionId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/code/zip/:sessionId — download project as zip
router.get("/zip/:sessionId", async (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const session = getOrRecoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const zipName = `${session.projectName}.zip`;
    const zipPath = path.join(path.dirname(session.projectDir), zipName);

    try {
        await CodeAgent._zipDirectory(session.projectDir, zipPath);
        res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
        res.setHeader("Content-Type", "application/zip");
        fs.createReadStream(zipPath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/code/save — save to permanent location
router.post("/save", express.json(), (req, res) => {
    const CodeAgent = getCodeAgent();
    if (!CodeAgent) return res.status(503).json({ error: "CodeAgent plugin not loaded" });

    const { sessionId, savePath } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const session = getOrRecoverSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const destination = savePath || path.join(os.homedir(), "btw-projects", session.projectName);

    try {
        if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(session.projectDir, destination, { recursive: true });
        res.json({ ok: true, savedTo: destination });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;