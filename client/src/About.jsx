import React from "react";

/**
 * AboutPage
 * ----------
 * Static informational page describing what Codebase Explorer does,
 * who it's for, current limitations, and basic security notes.
 */
export default function AboutPage() {
  return (
    <div className="card">
      {/* Page header */}
      <div className="cardHead">
        <div>
          <div className="cardTitle">About — Codebase Explorer</div>
          <div className="cardSub">
            What this tool does, who it’s for, and known limitations.
          </div>
        </div>
      </div>

      {/* Page content */}
      <div className="cardBody">
        <div className="aboutGrid">
          {/* What is it */}
          <section className="aboutSection">
            <h3 className="aboutH">What is it?</h3>
            <p className="aboutP">
              A tool that takes a code archive (ZIP) and returns two things:
              <b> a file tree</b> and a <b>dependency graph</b> (imports between JS/TS
              files).
            </p>
          </section>

          {/* Why is it useful */}
          <section className="aboutSection">
            <h3 className="aboutH">Why is it useful?</h3>
            <ul className="aboutList">
              <li>Quickly understand the structure of a codebase you didn’t write.</li>
              <li>Identify “central” files (many connections).</li>
              <li>Visualize architecture in a clear, graphical way.</li>
            </ul>
          </section>

          {/* Current limitations */}
          <section className="aboutSection">
            <h3 className="aboutH">Limitations (for now)</h3>
            <ul className="aboutList">
              <li>Full analysis is enabled only for ZIP (RAR/7Z are stored but not extracted).</li>
              <li>The graph is based on <b>local imports only</b> (./, ../).</li>
              <li>
                Very large projects can produce a dense graph — it’s recommended to start
                with a small/medium project.
              </li>
            </ul>
          </section>

          {/* Security notes */}
          <section className="aboutSection">
            <h3 className="aboutH">Security</h3>
            <p className="aboutP">
              The server includes basic protections against malicious ZIP files
              (unsafe paths, extraction limits). It also automatically cleans up
              temporary files on the server (TTL).
            </p>
          </section>
        </div>

        {/* Footer tip */}
        <div className="aboutFoot">
          Demo tip: upload a small project, search for a file, click a node, and show
          the “imports / imported by” panel.
        </div>
      </div>
    </div>
  );
}
