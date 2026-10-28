import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { NODE_HEIGHT } from "../graph/layout.ts";
import type { VNode } from "../graph/views.ts";
import { NODE_KINDS } from "../kinds.ts";
import type { NodeCard } from "../runtime/model.ts";

export type FlowNodeData = { v: VNode; width: number; dim: boolean; current: boolean; stepNo?: number; card?: NodeCard };
export type FlowNodeType = Node<FlowNodeData, "flow">;

function FlowNodeImpl({ data, selected }: NodeProps<FlowNodeType>) {
  const { v, width, dim, current, stepNo, card } = data;
  const kind = NODE_KINDS[v.kind] ?? NODE_KINDS.function;
  const cls = ["fl-node", selected && "is-selected", dim && "is-dim", v.start && "is-start", current && "is-current"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={{ width, height: NODE_HEIGHT, ["--kind" as string]: kind.color }} title={kind.title}>
      <Handle id="lt" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="ls" type="source" position={Position.Left} isConnectable={false} />
      <div className="fl-node-top">
        <span className="fl-chip">{kind.chip}</span>
        {stepNo !== undefined && <span className="fl-step">#{stepNo}</span>}
      </div>
      <div className="fl-node-label">{v.label}</div>
      {v.sub && <div className="fl-node-sub">{v.sub}</div>}
      {card && (
        <div className={`fl-card${card.fresh ? " is-fresh" : ""}`}>
          {card.rows.map((r, i) => (
            <div key={i} className={`fl-card-row ${r.tone ?? ""}`} title={r.text}>
              {r.k && <b>{r.k}</b>}
              <span>{r.text}</span>
            </div>
          ))}
        </div>
      )}
      <Handle id="rs" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="rt" type="target" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export const FlowNode = memo(FlowNodeImpl);
