import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { memo, useLayoutEffect, useRef } from "react";

export interface EdgePacket {
  label: string;
  reverse?: boolean;
  tone?: "return" | "error";
}

export type DataEdgeType = Edge<{ packets?: EdgePacket[]; color: string; tick: number; dur: number }, "data">;

/** A normal edge that can carry packets: dots with a value label travelling along its path. */
function DataEdgeImpl(props: EdgeProps<DataEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} labelX={labelX} labelY={labelY} label={props.label} labelStyle={props.labelStyle}
        labelShowBg={props.labelShowBg} labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding}
        labelBgBorderRadius={props.labelBgBorderRadius} style={props.style} markerEnd={props.markerEnd} interactionWidth={props.interactionWidth} />
      {data?.packets?.map((p, i) => (
        <PacketDot key={`${data.tick}:${i}`} path={path} packet={p} color={data.color} dur={data.dur} offset={i} />
      ))}
    </>
  );
}

export const DataEdge = memo(DataEdgeImpl);

const TONE: Record<string, string> = { return: "var(--k-route)", error: "var(--e-writes)" };

function PacketDot({ path, packet, color, dur, offset }: { path: string; packet: EdgePacket; color: string; dur: number; offset: number }) {
  const ref = useRef<SVGGElement>(null);
  // SMIL timelines start with the document: (re)start explicitly each time a packet appears
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<SVGAnimationElement>("animateMotion, animate").forEach((a) => a.beginElement());
  }, []);
  const fill = TONE[packet.tone ?? ""] ?? color;
  const text = packet.label;
  const w = Math.round(text.length * 6.1 + 14);
  return (
    <g ref={ref} opacity="0" className="fl-packet">
      <animateMotion dur={`${dur}s`} begin="indefinite" fill="freeze" path={path} calcMode="linear"
        keyPoints={packet.reverse ? "1;0" : "0;1"} keyTimes="0;1" />
      <animate attributeName="opacity" dur={`${dur}s`} begin="indefinite" fill="freeze" values="0;1;1;0.9" keyTimes="0;0.08;0.9;1" />
      <circle r={7} style={{ fill, stroke: "var(--bg-panel)", strokeWidth: 2 }} />
      <circle r={12} style={{ fill: "none", stroke: fill, strokeWidth: 1.5, opacity: 0.45 }} className="fl-packet-ring" />
      {text && (
        <g transform={`translate(${-w / 2}, ${-32 - offset * 22})`}>
          <rect width={w} height={19} rx={9.5} style={{ fill, stroke: "var(--bg-panel)", strokeWidth: 1.5 }} />
          <text x={w / 2} y={13} textAnchor="middle" style={{ fill: "#fff", fontSize: 10.5, fontFamily: "ui-monospace, Consolas, monospace", fontWeight: 600 }}>
            {text}
          </text>
        </g>
      )}
    </g>
  );
}
