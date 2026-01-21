/**
 * server.js
 * ---------
 * Backend API for Codebase Explorer.
 *
 * Responsibilities:
 * - Accept an uploaded archive (ZIP/RAR/7Z)
 * - Extract ZIP safely (Zip Slip + zip-bomb limits)
 * - Build:
 *   1) File tree
 *   2) Local-import dependency graph (JS/TS)
 *   3) Quick stats
 * - Return the analysis result as JSON
 * - Auto-clean temporary files after a TTL
 */

const express = require("express"); // Web framework for defining routes and middleware
const cors = require("cors"); // Enables CORS so the frontend can call the API from another origin
const multer = require("multer"); // Handles multipart/form-data file uploads
const path = require("path"); // Cross-platform path utilities
const fs = require("fs"); // File system utilities (read/write/remove files, folders)
const unzipper = require("unzipper"); // ZIP extraction library (stream-based)
const crypto = require("crypto"); // Provides randomUUID for job IDs

/* =========================
 * App Bootstrap
 * ========================= */
const app = express();
app.use(express.json()); // Parse JSON request bodies (not used in upload, but useful for future endpoints)

/* =========================
 * Config
 * ========================= */
const SERVER_PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// Max size of the uploaded archive itself (before extraction)
const MAX_UPLOAD_BYTES = 400 * 1024 * 1024; // 400MB

// Extraction safety limits (zip-bomb mitigation)
const MAX_EXTRACTED_TOTAL_BYTES = 1500 * 1024 * 1024; // 1.5GB total extracted
const MAX_EXTRACTED_FILE_BYTES = 30 * 1024 * 1024; // 30MB per extracted file
const MAX_EXTRACTED_FILES = 15000; // Max number of extracted files

// Cleanup TTL (how long to keep temp files on disk)
const CLEANUP_TTL_MS = 60 * 60 * 1000; // 1 hour

/* =========================
 * CORS (simple + permissive)
 * ========================= */
app.use(
  cors({
    // Allow requests from any origin (fine for local dev; in production you usually whitelist)
    origin: (origin, callback) => callback(null, true),

    // No cookies/credentials needed for this API
    credentials: false,
  })
);

/* =========================
 * Directories
 * ========================= */
const UPLOADS_DIR = path.join(__dirname, "uploads"); // Where uploaded archives are stored
const EXTRACTED_DIR = path.join(__dirname, "extracted"); // Where ZIP contents are extracted

// Ensure directories exist (creates them if missing)
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_DIR, { recursive: true });

/* =========================
 * Multer Upload Setup
 * ========================= */
const storageEngine = multer.diskStorage({
  // Where to write uploaded files
  destination: (req, file, callback) => callback(null, UPLOADS_DIR),

  // Filename format for stored archives
  filename: (req, file, callback) => callback(null, `${Date.now()}-${file.originalname}`),
});

// Allowed archive extensions (we accept these uploads, but only ZIP is analyzed currently)
const ALLOWED_ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z"];

const uploadArchive = multer({
  storage: storageEngine,
  // Hard limit on upload size
  limits: { fileSize: MAX_UPLOAD_BYTES },

  // Filter by file extension (basic validation)
  fileFilter: (req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_ARCHIVE_EXTENSIONS.includes(ext)) {
      return callback(new Error("INVALID_FILE_TYPE"), false);
    }
    callback(null, true);
  },
});

/* =========================
 * Health Endpoint
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "codebase-explorer-api" });
});

/* =========================
 * Upload + Analyze Endpoint
 * Field name: "archive"
 * ========================= */
app.post("/upload", uploadArchive.single("archive"), async (req, res, next) => {
  try {
    // Multer stores the file on disk and populates req.file
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const uploadedExtension = path.extname(req.file.originalname).toLowerCase();

    // Common metadata returned for any archive type
    const baseResponse = {
      ok: true,
      originalName: req.file.originalname,
      size: req.file.size,
      storedAs: req.file.filename,
      ext: uploadedExtension,
    };

    // For now: only ZIP extraction/analysis is implemented
    if (uploadedExtension !== ".zip") {
      return res.json({
        ...baseResponse,
        note: "RAR/7Z were saved on the server. Currently, analysis (tree/graph) is enabled only for ZIP. RAR/7Z extraction can be added later.",
      });
    }

    // ZIP analysis flow:
    const archivePath = req.file.path; // Full path to the uploaded archive on disk
    const jobId = crypto.randomUUID(); // Unique ID for this analysis job

    const extractionTargetDir = path.join(EXTRACTED_DIR, jobId);

    // Extract ZIP with safety guards
    await safeExtractZip(archivePath, extractionTargetDir, {
      maxFiles: MAX_EXTRACTED_FILES,
      maxFileBytes: MAX_EXTRACTED_FILE_BYTES,
      maxTotalBytes: MAX_EXTRACTED_TOTAL_BYTES,
    });

    // Collect all extracted files (absolute paths)
    const allExtractedFilesAbs = await walkDirectoryFiles(extractionTargetDir);

    // Common "noise" directories to ignore
    const ignoredFolderNames = [
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".cache",
      ".turbo",
      ".vite",
      "out",
    ];

    // Filter out ignored paths
    const analyzedFilesAbs = allExtractedFilesAbs.filter((absPath) => {
      const relPath = path.relative(extractionTargetDir, absPath).replace(/\\/g, "/");
      return !ignoredFolderNames.some((folder) => relPath.split("/").includes(folder));
    });

    // Build outputs
    const fileTree = buildFileTreeFromPaths(extractionTargetDir, analyzedFilesAbs);
    const importsGraph = await buildLocalImportsGraph(extractionTargetDir, analyzedFilesAbs);
    const stats = buildAnalysisStats(extractionTargetDir, analyzedFilesAbs, importsGraph);

    // Schedule cleanup of temp files
    scheduleJobCleanup(archivePath, extractionTargetDir);

    // Return everything the frontend needs
    return res.json({
      ...baseResponse,
      jobId,
      filesCount: analyzedFilesAbs.length,
      stats,
      tree: fileTree,
      graph: importsGraph,
    });
  } catch (err) {
    // Forward to centralized error handler
    next(err);
  }
});

/* =========================
 * Central Error Handler
 * ========================= */
app.use((err, req, res, next) => {
  if (err && err.message === "INVALID_FILE_TYPE") {
    return res.status(400).json({ ok: false, error: "Only ZIP / RAR / 7Z files are allowed." });
  }

  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "File is too large (limit: 100MB)." });
  }

  if (err && err.message === "UNSAFE_ZIP_PATH") {
    return res.status(400).json({ ok: false, error: "Invalid ZIP: unsafe file path found inside the archive." });
  }

  if (err && err.message === "ZIP_LIMITS_EXCEEDED") {
    return res.status(413).json({ ok: false, error: "ZIP exceeds extraction limits (too many files or extracted size too large)." });
  }

  console.error(err);
  res.status(500).json({ ok: false, error: "Server error" });
});

/* =========================
 * Safe ZIP Extraction
 * - Prevents Zip Slip (path traversal)
 * - Limits file count / file size / total extracted size
 * ========================= */
/**
 * Safely extracts a ZIP archive into a target directory.
 * @param {string} zipPath - Absolute path to the uploaded ZIP file.
 * @param {string} targetDir - Directory where files should be extracted.
 * @param {{maxFiles:number, maxFileBytes:number, maxTotalBytes:number}} limits - Safety limits.
 */
async function safeExtractZip(zipPath, targetDir, limits) {
  await fs.promises.mkdir(targetDir, { recursive: true });

  let extractedTotalBytes = 0;
  let extractedFilesCount = 0;

  // Read ZIP directory entries (metadata + streams)
  const zipDirectory = await unzipper.Open.file(zipPath);

  for (const entry of zipDirectory.files) {
    // Skip directory entries, only extract files
    if (entry.type === "Directory") continue;

    extractedFilesCount += 1;
    if (extractedFilesCount > limits.maxFiles) throw new Error("ZIP_LIMITS_EXCEEDED");

    // Uncompressed size is often available; still guard during streaming just in case
    const uncompressedSize = Number(entry.uncompressedSize || 0);

    if (uncompressedSize > limits.maxFileBytes) throw new Error("ZIP_LIMITS_EXCEEDED");

    extractedTotalBytes += uncompressedSize;
    if (extractedTotalBytes > limits.maxTotalBytes) throw new Error("ZIP_LIMITS_EXCEEDED");

    // --- Zip Slip protection ---
    // Normalize entry paths and reject unsafe ones like:
    //   "../../etc/passwd" or absolute paths "/root/..."
    const relPath = entry.path.replace(/\\/g, "/");
    const normalizedRelPath = path.posix.normalize(relPath);

    if (
      normalizedRelPath.startsWith("..") ||
      normalizedRelPath.includes("/../") ||
      path.posix.isAbsolute(normalizedRelPath)
    ) {
      throw new Error("UNSAFE_ZIP_PATH");
    }

    const destinationPath = path.join(targetDir, normalizedRelPath);

    // Extra guard: ensure final resolved path stays inside targetDir
    const resolvedTargetDir = path.resolve(targetDir);
    const resolvedDestinationPath = path.resolve(destinationPath);

    if (
      !resolvedDestinationPath.startsWith(resolvedTargetDir + path.sep) &&
      resolvedDestinationPath !== resolvedTargetDir
    ) {
      throw new Error("UNSAFE_ZIP_PATH");
    }

    // Ensure destination folder exists
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

    // Stream the entry into a file while enforcing per-file size limits
    await new Promise((resolve, reject) => {
      let writtenBytes = 0;

      const readStream = entry.stream();
      const writeStream = fs.createWriteStream(destinationPath);

      readStream.on("data", (chunk) => {
        writtenBytes += chunk.length;

        // If the file grows beyond limit, abort extraction
        if (writtenBytes > limits.maxFileBytes) {
          readStream.destroy();
          writeStream.destroy();
          reject(new Error("ZIP_LIMITS_EXCEEDED"));
        }
      });

      readStream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);

      readStream.pipe(writeStream);
    });
  }
}

/* =========================
 * Helper: Walk Directory
 * ========================= */
/**
 * Recursively collects all file paths under a directory.
 * @param {string} dir - Root directory to scan.
 * @returns {Promise<string[]>} Absolute paths to all files found.
 */
async function walkDirectoryFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectoryFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/* =========================
 * Helper: Build File Tree
 * ========================= */
/**
 * Builds a hierarchical folder/file structure from a list of absolute file paths.
 * @param {string} rootDir - Root extraction directory (used to create relative paths).
 * @param {string[]} filePathsAbs - Absolute file paths to include.
 * @returns {{name:string,type:"folder",children:any[]}} Tree object for the frontend.
 */
function buildFileTreeFromPaths(rootDir, filePathsAbs) {
  const root = { name: "root", type: "folder", children: [] };

  function getOrCreateFolderNode(parentNode, folderName) {
    let folderNode = parentNode.children.find(
      (child) => child.type === "folder" && child.name === folderName
    );

    if (!folderNode) {
      folderNode = { name: folderName, type: "folder", children: [] };
      parentNode.children.push(folderNode);

      // Keep folders first, then files, both alphabetically
      parentNode.children.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
      );
    }

    return folderNode;
  }

  for (const absPath of filePathsAbs) {
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");
    const parts = relPath.split("/").filter(Boolean);

    let currentNode = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        currentNode.children.push({ name, type: "file", path: relPath });
      } else {
        currentNode = getOrCreateFolderNode(currentNode, name);
      }
    }
  }

  // Sort recursively so the entire tree is stable and consistent
  function sortTree(node) {
    if (!node.children) return;

    node.children.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
    );

    node.children.forEach(sortTree);
  }

  sortTree(root);
  return root;
}

/* =========================
 * Helper: Imports Graph
 * (JS/TS local imports only)
 * ========================= */
/**
 * Checks whether an import specifier is local (relative path).
 * Examples: "./x", "../y"
 */
function isLocalImportSpecifier(spec) {
  return typeof spec === "string" && (spec.startsWith("./") || spec.startsWith("../"));
}

/**
 * Extracts import specifiers from JS/TS content using regex patterns.
 * Supports:
 * - import ... from "x"
 * - import "x"
 * - require("x")
 */
function extractImportSpecifiers(fileContent) {
  const specs = new Set();

  const IMPORT_FROM_RE = /import\s+[^;]*?\sfrom\s+["']([^"']+)["']/g;
  const IMPORT_BARE_RE = /import\s+["']([^"']+)["']/g;
  const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

  let match;
  while ((match = IMPORT_FROM_RE.exec(fileContent))) specs.add(match[1]);
  while ((match = IMPORT_BARE_RE.exec(fileContent))) specs.add(match[1]);
  while ((match = REQUIRE_RE.exec(fileContent))) specs.add(match[1]);

  return [...specs];
}

/**
 * Converts an import specifier into an actual file path within the extracted project.
 * It tries common JS/TS resolution patterns (file extension and index files).
 */
function resolveImportToRelativeFile(fromFileRelPath, importSpec, existingRelPathsSet) {
  const fromDir = path.posix.dirname(fromFileRelPath.replace(/\\/g, "/"));
  const base = path.posix.normalize(path.posix.join(fromDir, importSpec.replace(/\\/g, "/")));

  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    path.posix.join(base, "index.js"),
    path.posix.join(base, "index.jsx"),
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (existingRelPathsSet.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Builds a dependency graph from local imports inside JS/TS files.
 * @param {string} rootDir - Extraction root directory.
 * @param {string[]} filePathsAbs - Absolute file paths to consider.
 * @returns {Promise<{nodes:{id:string}[], edges:{source:string,target:string}[]}>}
 */
async function buildLocalImportsGraph(rootDir, filePathsAbs) {
  const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

  const codeFilesAbs = filePathsAbs.filter((absPath) =>
    CODE_EXTENSIONS.has(path.extname(absPath).toLowerCase())
  );

  // Convert absolute paths into relative IDs used by the frontend
  const relPaths = codeFilesAbs.map((absPath) => path.relative(rootDir, absPath).replace(/\\/g, "/"));
  const relPathsSet = new Set(relPaths);

  const nodes = relPaths.map((id) => ({ id }));
  const edges = [];
  const edgeKeySet = new Set(); // Prevent duplicate edges

  for (let i = 0; i < codeFilesAbs.length; i++) {
    const absPath = codeFilesAbs[i];
    const fromRelPath = relPaths[i];

    let fileContent = "";
    try {
      fileContent = await fs.promises.readFile(absPath, "utf8");
    } catch {
      // Ignore unreadable files (binary, permission, etc.)
      continue;
    }

    const localImportSpecs = extractImportSpecifiers(fileContent).filter(isLocalImportSpecifier);

    for (const spec of localImportSpecs) {
      const targetRelPath = resolveImportToRelativeFile(fromRelPath, spec, relPathsSet);
      if (!targetRelPath) continue;

      const edgeKey = `${fromRelPath}=>${targetRelPath}`;
      if (edgeKeySet.has(edgeKey)) continue;
      edgeKeySet.add(edgeKey);

      edges.push({ source: fromRelPath, target: targetRelPath });
    }
  }

  return { nodes, edges };
}

/* =========================
 * Stats
 * ========================= */
/**
 * Builds quick stats:
 * - file count per extension
 * - graph node/edge counts
 * - most connected files (degree)
 */
function buildAnalysisStats(rootDir, filePathsAbs, graph) {
  const countByExtension = {};

  for (const absPath of filePathsAbs) {
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");
    const ext = path.extname(relPath).toLowerCase() || "(none)";
    countByExtension[ext] = (countByExtension[ext] || 0) + 1;
  }

  // Degree = incoming + outgoing connections
  const degreeByNode = new Map();
  for (const node of graph.nodes) degreeByNode.set(node.id, 0);

  for (const edge of graph.edges) {
    degreeByNode.set(edge.source, (degreeByNode.get(edge.source) || 0) + 1);
    degreeByNode.set(edge.target, (degreeByNode.get(edge.target) || 0) + 1);
  }

  const topDegree = [...degreeByNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, degree]) => ({ id, degree }));

  return {
    exts: countByExtension,
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      topDegree,
    },
  };
}

/* =========================
 * Cleanup
 * ========================= */
/**
 * Schedules deletion of the uploaded archive and the extracted directory after TTL.
 */
function scheduleJobCleanup(archivePath, extractionTargetDir) {
  setTimeout(async () => {
    try {
      await safeRemovePath(archivePath);
      await safeRemovePath(extractionTargetDir);
    } catch {
      // Intentionally ignore cleanup errors
    }
  }, CLEANUP_TTL_MS);
}

/**
 * Safely removes a file or directory if it exists.
 */
async function safeRemovePath(targetPath) {
  if (!targetPath) return;
  if (!fs.existsSync(targetPath)) return;
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

/* =========================
 * Start Server
 * ========================= */
app.listen(SERVER_PORT, () => {
  console.log(`API running on http://localhost:${SERVER_PORT}`);
});
