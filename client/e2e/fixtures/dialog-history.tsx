import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreationDialog } from "../../src/CreationDialog.js";
import { installModalHistoryGuard } from "../../src/modal-history.js";

const stopHistory = installModalHistoryGuard();
if (import.meta.hot) import.meta.hot.dispose(stopHistory);

function Fixture() {
  const [outer, setOuter] = useState(false), [inner, setInner] = useState(false);
  const [draft, setDraft] = useState(""), [parent, setParent] = useState(""), [child, setChild] = useState("hello");
  return <><textarea aria-label="Background" value={draft} onChange={e => setDraft(e.target.value)}/>
    <button onClick={() => setOuter(true)}>Open parent</button>
    {outer && <CreationDialog title="Parent" closeLabel="Close parent" showHost={false} close={() => setOuter(false)}>
      <textarea aria-label="Parent draft" value={parent} onChange={e => setParent(e.target.value)}/>
      <button onClick={() => setInner(true)}>Open child</button>
      {inner && <CreationDialog title="Child" closeLabel="Close child" showHost={false} close={() => setInner(false)}>
        <textarea aria-label="Child draft" value={child} onChange={e => setChild(e.target.value)}/>
      </CreationDialog>}
    </CreationDialog>}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
