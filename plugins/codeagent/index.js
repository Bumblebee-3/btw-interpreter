"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const archiver = require("archiver");
const treeKill = require("tree-kill");

// Module-level session store: sessionId → { projectDir, projectName, files[], runningPid }
const sessions = new Map();

// Module-level store for running processes: sessionId → ChildProcess
const runningProcesses = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeProjectName(name) {
    return String(name || "btw-project")
        .toLowerCase()
        .replace(/[^a-z0-9\-_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "btw-project";
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeProjectFile(projectDir, relativePath, content) {
    const root = path.resolve(projectDir);
    const fullPath = path.resolve(root, String(relativePath || ""));
    if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Invalid project file path: ${relativePath}`);
    }
    ensureDir(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, "utf-8");
}

function getSessionProjectDir(tempBaseDir, sessionId, projectName) {
    return path.join(tempBaseDir, sessionId, projectName);
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
            const ext = path.extname(entry.name).toLowerCase();
            const languageMap = {
                ".js": "javascript", ".ts": "typescript", ".json": "json",
                ".md": "markdown", ".html": "html", ".css": "css",
                ".sh": "shell", ".env": "plaintext", ".txt": "plaintext",
                ".toml": "ini", ".yaml": "yaml", ".yml": "yaml"
            };
            results.push({
                path: relativePath,
                type: "file",
                language: languageMap[ext] || "plaintext"
            });
        }
    }
    return results;
}

function getLanguageForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        ".js": "javascript", ".ts": "typescript", ".json": "json",
        ".md": "markdown", ".html": "html", ".css": "css", ".sh": "shell"
    };
    return map[ext] || "plaintext";
}

function buildPanelPayload(type, data) {
    return `__PANEL_START__${JSON.stringify({ type, ...data })}__PANEL_END__\n\n`;
}

// ─── RAG-aware code generation ────────────────────────────────────────────────

// Query the RAG db for context relevant to a specific file/topic
// Returns { context: string, attributions: Array<{table,similarity,preview}> }
async function fetchRAGContextForTopic(topic, obj) {
    if (!obj.db || !obj.db.dbPath) return { context: "", attributions: [] };
    try {
        const results = await obj.db.searchDB(topic, 8, obj.table_config);
        if (!results || results.length === 0) return { context: "", attributions: [] };

        // Only use results above a low threshold — code generation benefits from
        // looser matching than direct QA
        const usable = results.filter(r =>
            parseFloat(String(r.similarity || "0").replace("%", "")) >= 20
        );
        if (usable.length === 0) return { context: "", attributions: [] };

        const context = usable.map(r => r.text).join("\n\n---\n\n");
        const attributions = usable.map(r => ({
            table: r.id ? String(r.id).split(":")[0] : "db",
            similarity: r.similarity,
            preview: String(r.text || "").slice(0, 80).replace(/\n/g, " ")
        }));

        return { context, attributions };
    } catch (_) {
        return { context: "", attributions: [] };
    }
}

// Generate the content of a single file given its description and any RAG context
async function generateFileContent(fileSpec, ragContext, obj) {
    // fileSpec: { path: "commands/balance.js", description: "Shows user cash and bank balance" }
    const ragBlock = ragContext
        ? `\nRelevant framework/library documentation from the knowledge base:\n${ragContext}\n`
        : "";

    const prompt = `You are a JavaScript developer. Write the complete contents of the file \`${fileSpec.path}\`.

File purpose: ${fileSpec.description}
${ragBlock}
Rules:
- Output ONLY the raw file content, no markdown fences, no explanation before or after.
- The code must be complete, runnable, and correct.
- Use CommonJS (require/module.exports) syntax.
- Include helpful inline comments.
- Do not truncate.`;

    const content = await obj.customQuery(prompt);
    // Strip any accidental markdown fences the model adds
    return String(content || "")
        .replace(/^```[a-z]*\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();
}

// ─── Project planning ─────────────────────────────────────────────────────────

async function planProject(description, projectName, obj) {
    const prompt = `You are a JavaScript project architect. The user wants to build:

"${description}"

Project name: ${projectName}

Return ONLY valid JSON (no markdown, no explanation) matching this schema exactly:
{
  "summary": "one sentence describing what this project does",
  "setup_instructions": "how to install deps and run (2-3 sentences)",
  "dependencies": ["pkg1", "pkg2"],
  "dev_dependencies": [],
  "files": [
    {
      "path": "relative/path/to/file.js",
      "description": "what this file does and what it must contain",
      "rag_query": "short search string to find relevant framework docs in a vector db"
    }
  ]
}

Rules:
- Include package.json, .env.example, README.md, and all source files
- paths must use forward slashes and be relative to project root
- rag_query should be 3-8 words describing what library/API docs would help write this file
- Be exhaustive — include every file needed for a working project
- For Discord/bot projects, include one file per command`;

    const raw = await obj.customQuery(prompt);
    try {
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) throw new Error("no JSON");
        return JSON.parse(match[0]);
    } catch (_) {
        // Fallback minimal plan
        return {
            summary: description,
            setup_instructions: "npm install && node index.js",
            dependencies: [],
            dev_dependencies: [],
            files: [
                { path: "index.js", description: "Main entry point", rag_query: "javascript main entry point" },
                { path: "README.md", description: "Project documentation", rag_query: "readme documentation" }
            ]
        };
    }
}

// ─── Plugin Class ─────────────────────────────────────────────────────────────

class CodeAgent {
    constructor(temp_base_dir, obj) {
        this.tempBaseDir = temp_base_dir || path.join(os.tmpdir(), "btw-codeagent");
        this.obj = obj;
        ensureDir(this.tempBaseDir);
    }

    _getSessionId() {
        return String(this.obj.sessionId || "default");
    }

    _getSession() {
        const sid = this._getSessionId();
        return sessions.get(sid) || null;
    }

    _setSession(data) {
        const sid = this._getSessionId();
        sessions.set(sid, data);
    }

    // ── getProjectStatus (function, not workflow) ──────────────────────────────

    async getProjectStatus(input) {
        const session = this._getSession();
        if (!session) {
            return JSON.stringify({ status: "no_project", message: "No project is currently active for this session." });
        }
        const files = walkDir(session.projectDir, session.projectDir);
        return JSON.stringify({
            status: "active",
            projectName: session.projectName,
            projectDir: session.projectDir,
            files,
            hasRunningProcess: runningProcesses.has(this._getSessionId())
        });
    }

    // ── scaffoldProjectWorkflow ────────────────────────────────────────────────

    async scaffoldProjectWorkflow(params, context) {
        const description = String(params.project_description || "").trim();
        if (!description) {
            return { status: "needs_input", field: "project_description", message: "Please describe what you want the project to do." };
        }

        const rawName = String(params.project_name || "").trim() ||
            description.split(" ").slice(0, 4).join("-");
        const projectName = sanitizeProjectName(rawName);
        const projectDir = getSessionProjectDir(this.tempBaseDir, this._getSessionId(), projectName);

        // Clean up any existing project for this session
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
        ensureDir(projectDir);

        // Step 1: Plan the project structure
        let plan;
        try {
            plan = await planProject(description, projectName, this.obj);
        } catch (err) {
            return `Failed to plan project: ${err.message}`;
        }

        // Step 2: Generate each file with RAG context
        const attribution = {};
        const generatedFiles = [];
        const stepLines = [];

        for (const fileSpec of plan.files) {
            // Fetch RAG context for this specific file
            const { context: ragContext, attributions } = await fetchRAGContextForTopic(
                fileSpec.rag_query || fileSpec.description,
                this.obj
            );

            attribution[fileSpec.path] = attributions;

            let content;
            try {
                content = await generateFileContent(fileSpec, ragContext, this.obj);
            } catch (err) {
                content = `// Error generating this file: ${err.message}\n`;
            }

            writeProjectFile(projectDir, fileSpec.path, content);
            generatedFiles.push({ path: fileSpec.path, language: getLanguageForFile(fileSpec.path) });

            // Build step line with RAG attribution markers if applicable
            const ragMarker = attributions.length > 0
                ? ` %%RAG[table=${attributions[0].table},sim=${attributions[0].similarity},preview=${attributions[0].preview}]%%`
                : "";
            stepLines.push(`- \`${fileSpec.path}\` — ${fileSpec.description}${ragMarker}`);
        }

        // Step 3: Generate package.json if not already in files
        const hasPackageJson = plan.files.some(f => f.path === "package.json");
        if (!hasPackageJson) {
            const pkgJson = {
                name: projectName,
                version: "1.0.0",
                description: plan.summary,
                main: "index.js",
                scripts: { start: "node index.js" },
                dependencies: plan.dependencies.reduce((acc, dep) => { acc[dep] = "latest"; return acc; }, {}),
                devDependencies: plan.dev_dependencies.reduce((acc, dep) => { acc[dep] = "latest"; return acc; }, {})
            };
            writeProjectFile(projectDir, "package.json", JSON.stringify(pkgJson, null, 2));
            generatedFiles.push({ path: "package.json", language: "json" });
        }

        // Persist session
        this._setSession({ projectDir, projectName, files: generatedFiles });

        // Build response
        const panelPayload = buildPanelPayload("code_project", {
            projectName,
            sessionId: this._getSessionId(),
            projectDir,
            files: generatedFiles,
            attribution
        });

        const responseText = [
            `## ✅ Project \`${projectName}\` scaffolded`,
            "",
            plan.summary,
            "",
            "**Files created:**",
            ...stepLines,
            "",
            `**Setup:** ${plan.setup_instructions}`,
            "",
            "_The code editor has opened on the right. You can browse files, edit them, and hit Run to execute._"
        ].join("\n");

        return panelPayload + responseText;
    }

    // ── runCodeWorkflow ────────────────────────────────────────────────────────

    async runCodeWorkflow(params, context) {
        const session = this._getSession();
        if (!session) {
            return "No active project to run. Scaffold a project first.";
        }

        const entryFile = String(params.entry_file || "index.js").replace(/[^a-zA-Z0-9_\-./]/g, "");
        const entryPath = path.join(session.projectDir, entryFile);

        if (!fs.existsSync(entryPath)) {
            return `Entry file \`${entryFile}\` does not exist in the project. Available files: ${walkDir(session.projectDir, session.projectDir).filter(f => f.type === "file").map(f => f.path).join(", ")}`;
        }

        // Kill any existing running process
        const existingPid = runningProcesses.get(this._getSessionId());
        if (existingPid) {
            try { treeKill(existingPid.pid); } catch (_) {}
            runningProcesses.delete(this._getSessionId());
        }

        // This workflow returns a signal to the frontend to connect to the SSE run endpoint
        // The actual execution happens via /api/code/run SSE endpoint
        const panelPayload = buildPanelPayload("code_run", {
            sessionId: this._getSessionId(),
            entryFile,
            projectName: session.projectName
        });

        return panelPayload + `Running \`${entryFile}\` — output will appear in the terminal panel.`;
    }

    // ── saveProjectWorkflow ────────────────────────────────────────────────────

    async saveProjectWorkflow(params, context) {
        const session = this._getSession();
        if (!session) {
            return "No active project to save.";
        }

        const defaultSavePath = path.join(os.homedir(), "btw-projects", session.projectName);
        const savePath = String(params.save_path || defaultSavePath).trim();

        try {
            if (fs.existsSync(savePath)) {
                fs.rmSync(savePath, { recursive: true, force: true });
            }
            fs.cpSync(session.projectDir, savePath, { recursive: true });
            return `Project saved to \`${savePath}\`. Run \`cd "${savePath}" && npm install && node index.js\` to get started.`;
        } catch (err) {
            return `Failed to save project: ${err.message}`;
        }
    }

    // ── emailProjectWorkflow ───────────────────────────────────────────────────

    async emailProjectWorkflow(params, context) {
        const session = this._getSession();
        if (!session) {
            return "No active project to email.";
        }

        const recipient = String(params.recipient || "").trim();
        if (!recipient) {
            return { status: "needs_input", field: "recipient", message: "Who should I send the project to?" };
        }

        // Step 1: Zip the project
        const zipPath = path.join(this.tempBaseDir, this._getSessionId(), `${session.projectName}.zip`);
        try {
            await zipDirectory(session.projectDir, zipPath);
        } catch (err) {
            return `Failed to zip project: ${err.message}`;
        }

        // Step 2: Delegate to Gmail plugin via obj.customQuery chain
        // We use the Gmail plugin directly if loaded
        const gmailPlugin = (this.obj.plugins || []).find(p =>
            String(p?.data?.name || "").toLowerCase() === "gmail"
        );

        if (!gmailPlugin) {
            return `Project zipped at \`${zipPath}\`. Gmail plugin is not loaded — attach the zip manually.`;
        }

        try {
            const { loadPlugin } = require("../../src/interpreter/pluginHandler.js");
            const gmailInstance = loadPlugin(gmailPlugin, gmailPlugin.params);

            const zipBuffer = fs.readFileSync(zipPath);
            const base64Zip = zipBuffer.toString("base64");
            const zipFilename = `${session.projectName}.zip`;

            const subject = `${session.projectName} — code from BTW`;
            return await gmailInstance.sendEmailWorkflow({
                recipient,
                subject,
                body: String(params.message || `Please find the ${session.projectName} project attached.`),
                attachment: {
                    mimeType: "application/zip",
                    filename: zipFilename,
                    base64: base64Zip
                }
            }, context);
        } catch (err) {
            return `Zipped to \`${zipPath}\` but email failed: ${err.message}`;
        }
    }
}

// ─── Zip helper ───────────────────────────────────────────────────────────────

function zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        ensureDir(path.dirname(outPath));
        const output = fs.createWriteStream(outPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", resolve);
        archive.on("error", reject);

        archive.pipe(output);
        archive.directory(sourceDir, path.basename(sourceDir));
        archive.finalize();
    });
}

// Export the session store and runningProcesses for use by codeRouter
CodeAgent._sessions = sessions;
CodeAgent._runningProcesses = runningProcesses;
CodeAgent._zipDirectory = zipDirectory;

module.exports = CodeAgent;