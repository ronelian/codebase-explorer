import { useCallback, useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, MarkerType } from "reactflow";
import { Routes, Route, Link } from "react-router-dom";
import AboutPage from "./About";

import dagre from "dagre";
import "reactflow/dist/style.css";
import "./app.css";

/**
 * App
 * ---
 * Main UI for:
 * 1) uploading an archive (ZIP preferred),
 * 2) showing a file tree,
 * 3) visualizing a dependency graph (local imports),
 * 4) exploring incoming/outgoing relations for a selected file.
 */

/* =========================
 * Constants & Small Helpers
 * ========================= */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
console.log("API_BASE_URL from env:", API_BASE_URL);

/**
 * Returns a shorter display version of a path (last 2 segments).
 * Example: "src/components/Button.jsx" -> "components/Button.jsx"
 */
function getShortPathLabel(fullPath) {
  return fullPath.split("/").slice(-2).join("/");
}

/* =========================
 * Graph Layout (Dagre)
 * ========================= */
/**
 * Applies a left-to-right layout to nodes using Dagre.
 * ReactFlow expects node.position to be the top-left corner,
 * while Dagre outputs center-based coordinates.
 */
function applyDagreLayout(nodes, edges) {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Left-to-right layout, with spacing between nodes/layers.
  dagreGraph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });

  // Dagre needs node sizes to compute the layout.
  nodes.forEach((node) => dagreGraph.setNode(node.id, { width: 240, height: 78 }));
  edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

  dagre.layout(dagreGraph);

  return {
    nodes: nodes.map((node) => {
      const layoutPosition = dagreGraph.node(node.id);
      return {
        ...node,
        // Convert Dagre's center position to ReactFlow's top-left position.
        position: { x: layoutPosition.x - 120, y: layoutPosition.y - 39 },
      };
    }),
    edges,
  };
}

/* =========================
 * ReactFlow Custom Node
 * ========================= */
/**
 * FileNode
 * --------
 * A custom ReactFlow node that represents a file in the codebase.
 * - Left handle: incoming edges (imports into this file)
 * - Right handle: outgoing edges (imports from this file)
 */
function FileNode({ data, selected }) {
  return (
    <div className={"node " + (selected ? "nodeSelected" : "")} title={data.fullPath}>
      <Handle type="target" position={Position.Left} />
      <div className="nodeTitle">{data.label}</div>
      <div className="nodeSub">{data.fullPath}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const reactFlowNodeTypes = { fileNode: FileNode };

/* =========================
 * File Tree Helpers
 * ========================= */
/**
 * Returns true if the node OR any of its descendants match the search query.
 * This allows folders to remain visible if they contain matching files.
 */
function doesSubtreeMatchQuery(treeNode, query) {
  const q = query.toLowerCase();

  if ((treeNode.name || "").toLowerCase().includes(q)) return true;
  if ((treeNode.path || "").toLowerCase().includes(q)) return true;

  return (treeNode.children || []).some((child) => doesSubtreeMatchQuery(child, query));
}

/* =========================
 * File Tree Component
 * ========================= */
/**
 * FileTree
 * --------
 * Recursive component that renders the file/folder tree.
 * - Clicking a folder toggles expand/collapse.
 * - Clicking a file selects it and highlights it in the graph.
 * - When a query exists, only relevant branches are shown.
 */
function FileTree({ node, depth = 0, selectedPath, onSelectPath, query }) {
  const [isOpen, setIsOpen] = useState(depth < 1);

  const isFolder = node.type === "folder";
  const normalizedQuery = query?.toLowerCase() || "";

  const nodeMatchesQuery =
    !normalizedQuery ||
    (node.name && node.name.toLowerCase().includes(normalizedQuery)) ||
    (node.path && node.path.toLowerCase().includes(normalizedQuery));

  const children = node.children || [];
  const anyChildMatchesQuery = !normalizedQuery
    ? true
    : children.some((child) => doesSubtreeMatchQuery(child, normalizedQuery));

  // If searching and neither this node nor any descendant matches -> hide it.
  if (normalizedQuery && !nodeMatchesQuery && !anyChildMatchesQuery) return null;

  return (
    <div style={{ marginInlineStart: depth * 10 }}>
      <div
        className={"treeRow " + (node.path && node.path === selectedPath ? "treeRowSelected" : "")}
        onClick={() => {
          if (isFolder) setIsOpen(!isOpen);
          if (node.type === "file" && node.path) onSelectPath(node.path);
        }}
      >
        <span className="treeIcon">{isFolder ? "📁" : "📄"}</span>
        <span className="treeName">{node.name}</span>
      </div>

      {isFolder && isOpen && (
        <div className="treeChildren">
          {children.map((child, index) => (
            <FileTree
              key={(child.path || child.name) + ":" + index}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              query={query}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* =========================
 * Route Wrapper
 * ========================= */
/**
 * HomeRoute
 * ---------
 * A small wrapper around the home route contents.
 * (Kept to match the original structure, can be removed if desired.)
 */
function HomeRoute({ children }) {
  return children;
}

/* =========================
 * Main App Component
 * ========================= */
export default function App() {
  // Selected archive file
  const [selectedArchiveFile, setSelectedArchiveFile] = useState(null);

  // Server response payload: tree, graph, stats, etc.
  const [analysisResult, setAnalysisResult] = useState(null);

  // UI state
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  // Selected file path inside the analyzed project (used for highlighting)
  const [selectedFilePath, setSelectedFilePath] = useState(null);

  // Search query to filter tree and graph
  const [searchQuery, setSearchQuery] = useState("");

  /**
   * uploadAndAnalyze
   * ---------------
   * Sends the selected archive to the backend and stores the analysis result.
   */
  const uploadAndAnalyze = useCallback(async () => {
    if (!selectedArchiveFile) return;

    setIsUploading(true);
    setErrorMessage(null);
    setSelectedFilePath(null);
    setAnalysisResult(null);

    try {
      const formData = new FormData();
      formData.append("archive", selectedArchiveFile);

      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: "POST",
        body: formData,
      });

      const json = await response.json();

      if (!response.ok || !json.ok) {
        throw new Error(json?.error || "Upload failed");
      }

      setAnalysisResult(json);
    } catch (err) {
      setErrorMessage(err?.message || "Server error");
    } finally {
      setIsUploading(false);
    }
  }, [selectedArchiveFile]);

  /**
   * graphAdjacencyIndex
   * -------------------
   * Builds fast lookup maps for:
   * - outgoing edges: file -> [imports]
   * - incoming edges: file -> [importedBy]
   */
  const graphAdjacencyIndex = useMemo(() => {
    if (!analysisResult?.graph) return null;

    const outgoingByNode = new Map();
    const incomingByNode = new Map();

    for (const node of analysisResult.graph.nodes) {
      outgoingByNode.set(node.id, []);
      incomingByNode.set(node.id, []);
    }

    for (const edge of analysisResult.graph.edges) {
      if (outgoingByNode.has(edge.source)) outgoingByNode.get(edge.source).push(edge.target);
      if (incomingByNode.has(edge.target)) incomingByNode.get(edge.target).push(edge.source);
    }

    return { outgoingByNode, incomingByNode };
  }, [analysisResult]);

  /**
   * reactFlowLayout
   * --------------
   * Creates ReactFlow-friendly nodes/edges, applies filtering by query,
   * and computes positions using Dagre.
   */
  const reactFlowLayout = useMemo(() => {
    if (!analysisResult?.graph) return null;

    const q = searchQuery.trim().toLowerCase();
    const isAllowedByQuery = (id) => !q || id.toLowerCase().includes(q);

    // Filter nodes by query
    const filteredNodeIds = analysisResult.graph.nodes.map((n) => n.id).filter(isAllowedByQuery);

    const nodes = filteredNodeIds.map((id) => ({
      id,
      type: "fileNode",
      data: { label: getShortPathLabel(id), fullPath: id },
      position: { x: 0, y: 0 },
      selected: selectedFilePath === id,
    }));

    const edges = analysisResult.graph.edges
      .filter((edge) => isAllowedByQuery(edge.source) && isAllowedByQuery(edge.target))
      .map((edge, index) => {
        const isEdgeRelatedToSelection =
          selectedFilePath && (edge.source === selectedFilePath || edge.target === selectedFilePath);

        return {
          id: "e" + index,
          source: edge.source,
          target: edge.target,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: Boolean(isEdgeRelatedToSelection),
          className: selectedFilePath ? (isEdgeRelatedToSelection ? "edgeHot" : "edgeDim") : "",
        };
      });

    return applyDagreLayout(nodes, edges);
  }, [analysisResult, searchQuery, selectedFilePath]);

  /**
   * selectedFileConnections
   * -----------------------
   * For the currently selected file, derive:
   * - outgoing imports
   * - incoming imported-by
   */
  const selectedFileConnections = useMemo(() => {
    if (!selectedFilePath || !graphAdjacencyIndex) return null;

    const outgoing = graphAdjacencyIndex.outgoingByNode.get(selectedFilePath) || [];
    const incoming = graphAdjacencyIndex.incomingByNode.get(selectedFilePath) || [];

    return { outgoing, incoming };
  }, [selectedFilePath, graphAdjacencyIndex]);

  return (
    <div className="page">
      <div className="container">
        {/* Header */}
        <div className="header">
          <div>
            <h1>Codebase Explorer</h1>
            <p>Upload a project ZIP and get a file tree + dependency graph (imports).</p>
          </div>

          <div className="headerRight">
            <div className="headerLinks">
              <Link className="linkPill" to="/">
                Home
              </Link>
              <Link className="linkPill" to="/about">
                About
              </Link>
            </div>

            <div className="pill">
              <span>Allowed:</span>
              <b>ZIP</b>
              <span>({`RAR/7Z are stored but not analyzed yet`})</span>
            </div>
          </div>
        </div>

        <Routes>
          <Route
            path="/"
            element={
              <HomeRoute>
                {/* Upload card */}
                <div className="card">
                  <div className="cardHead">
                    <div>
                      <div className="cardTitle">Upload & Analyze</div>
                      <div className="cardSub">
                        ZIP is recommended. Extraction includes basic safety limits (anti malicious ZIP).
                      </div>
                    </div>

                    {analysisResult?.stats?.graph && (
                      <div className="pill">
                        <span>Nodes:</span> <b>{analysisResult.stats.graph.nodes}</b>
                        <span>Edges:</span> <b>{analysisResult.stats.graph.edges}</b>
                      </div>
                    )}
                  </div>

                  <div className="cardBody">
                    <div className="uploadRow">
                      <div className="fileBox">
                        <input
                          type="file"
                          accept=".zip,.rar,.7z"
                          onChange={(e) => setSelectedArchiveFile(e.target.files?.[0] || null)}
                        />
                        <span className="muted">
                          {selectedArchiveFile ? `Selected: ${selectedArchiveFile.name}` : "No file selected"}
                        </span>
                      </div>

                      <button
                        className={"btn " + (selectedArchiveFile && !isUploading ? "btnPrimary" : "btnMuted")}
                        onClick={uploadAndAnalyze}
                        disabled={!selectedArchiveFile || isUploading}
                      >
                        {isUploading ? "Uploading & analyzing..." : "Upload"}
                      </button>

                      <input
                        className="search"
                        placeholder="Search files (filters tree + graph)..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>

                    {errorMessage && <div className="alert alertError">{errorMessage}</div>}
                    {analysisResult?.note && <div className="alert alertInfo">{analysisResult.note}</div>}

                    {analysisResult?.stats?.exts && (
                      <div className="stats">
                        <div className="statsTitle">Quick Stats</div>
                        <div className="statsGrid">
                          {Object.entries(analysisResult.stats.exts)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 10)
                            .map(([ext, count]) => (
                              <div key={ext} className="statChip">
                                <span>{ext}</span>
                                <b>{count}</b>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Main grid */}
                <div className="grid2">
                  {/* Tree */}
                  <div className="card">
                    <div className="cardHead">
                      <div>
                        <div className="cardTitle">File Tree</div>
                        <div className="cardSub">Click a file to select it and highlight it in the graph.</div>
                      </div>

                      {analysisResult?.filesCount != null && (
                        <div className="pill">
                          <span>Files:</span> <b>{analysisResult.filesCount}</b>
                        </div>
                      )}
                    </div>

                    <div className="cardBody">
                      <div className="treeBox">
                        {analysisResult?.tree ? (
                          <FileTree
                            node={analysisResult.tree}
                            selectedPath={selectedFilePath}
                            onSelectPath={setSelectedFilePath}
                            query={searchQuery}
                          />
                        ) : (
                          <div className="muted">Upload a ZIP to see the file tree.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Graph + details */}
                  <div className="card">
                    <div className="cardHead">
                      <div>
                        <div className="cardTitle">Dependency Graph</div>
                        <div className="cardSub">Click a node to see imports / imported-by.</div>
                      </div>

                      {selectedFilePath ? (
                        <div className="pill">
                          <span>Selected:</span> <b title={selectedFilePath}>{getShortPathLabel(selectedFilePath)}</b>
                        </div>
                      ) : (
                        <div className="pill">Select a file in the tree or graph</div>
                      )}
                    </div>

                    <div className="cardBody">
                      <div className="graphSplit">
                        <div className="graphBox">
                          {reactFlowLayout ? (
                            <ReactFlow
                              nodes={reactFlowLayout.nodes}
                              edges={reactFlowLayout.edges}
                              nodeTypes={reactFlowNodeTypes}
                              fitView
                              onNodeClick={(_, node) => setSelectedFilePath(node.id)}
                            >
                              <Background />
                              <MiniMap />
                              <Controls />
                            </ReactFlow>
                          ) : (
                            <div className="emptyGraph">Upload a ZIP to see the dependency graph.</div>
                          )}
                        </div>

                        <div className="sidePanel">
                          <div className="sideTitle">File Details</div>

                          {!selectedFilePath && (
                            <div className="muted">Select a file to see its relationships.</div>
                          )}

                          {selectedFilePath && selectedFileConnections && (
                            <>
                              <div className="kv">
                                <div className="k">Path</div>
                                <div className="v">{selectedFilePath}</div>
                              </div>

                              <div className="lists">
                                <div className="listBox">
                                  <div className="listTitle">Imports (outgoing)</div>

                                  {selectedFileConnections.outgoing.length === 0 ? (
                                    <div className="muted">None</div>
                                  ) : (
                                    <ul>
                                      {selectedFileConnections.outgoing.slice(0, 30).map((p) => (
                                        <li key={p}>
                                          <button
                                            className="linkBtn"
                                            onClick={() => setSelectedFilePath(p)}
                                            title={p}
                                          >
                                            {getShortPathLabel(p)}
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>

                                <div className="listBox">
                                  <div className="listTitle">Imported By (incoming)</div>

                                  {selectedFileConnections.incoming.length === 0 ? (
                                    <div className="muted">None</div>
                                  ) : (
                                    <ul>
                                      {selectedFileConnections.incoming.slice(0, 30).map((p) => (
                                        <li key={p}>
                                          <button
                                            className="linkBtn"
                                            onClick={() => setSelectedFilePath(p)}
                                            title={p}
                                          >
                                            {getShortPathLabel(p)}
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      {analysisResult?.stats?.graph?.topDegree?.length ? (
                        <div className="topFiles">
                          <div className="statsTitle">Most Connected Files (High Degree)</div>
                          <div className="statsGrid">
                            {analysisResult.stats.graph.topDegree.map((item) => (
                              <button
                                key={item.id}
                                className="statChip statBtn"
                                onClick={() => setSelectedFilePath(item.id)}
                                title={item.id}
                              >
                                <span>{getShortPathLabel(item.id)}</span>
                                <b>{item.degree}</b>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="footer">
                  Demo tip: upload a small project, click a few nodes, and show the dependency panel + search.
                </div>
              </HomeRoute>
            }
          />

          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </div>
    </div>
  );
}
