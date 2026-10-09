"use client";
import { useRef, type RefObject } from "react";
import { groupColorIndex, type Island, type MapNode } from "@/lib/map-layout";
import { groupColorStyle, type GroupColor } from "@/lib/group-colors";
import {
  overviewBounds,
  overviewPoint,
  type Bounds,
  type WorldBounds,
} from "@/lib/map-management";

export function MapMinimap({
  islands,
  groupColors = [],
  size,
  viewport,
  viewportRef,
  selectedNode,
  onLocate,
  onPan,
  onFit,
  onGroup,
}: {
  islands: Island[];
  groupColors?: GroupColor[];
  size: WorldBounds;
  viewport: Bounds;
  viewportRef: RefObject<SVGRectElement | null>;
  selectedNode?: MapNode;
  onLocate: (point: { x: number; y: number }, animate: boolean) => void;
  onPan: (x: number, y: number) => void;
  onFit: () => void;
  onGroup: (island: Island) => void;
}) {
  const dragging = useRef<{
      id: number;
      x: number;
      y: number;
      group: Island | undefined;
      moved: boolean;
    } | null>(null),
    domain = overviewBounds(size);
  function locate(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    onLocate(
      overviewPoint(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        rect,
        domain,
        size,
      ),
      false,
    );
  }
  return (
    <div className="map-minimap" data-testid="map-minimap">
      <div className="minimap-heading">
        <span>群岛全图</span>
        <small>拖动定位</small>
      </div>
      <svg
        viewBox={`${domain.x} ${domain.y} ${domain.width} ${domain.height}`}
        preserveAspectRatio="none"
        role="group"
        aria-label="地图定位小窗"
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0 || dragging.current) return;
          const name = (e.target as Element)
            .closest("[data-mini-group]")
            ?.getAttribute("data-mini-group");
          const group = islands.find((i) => i.name === name);
          e.preventDefault();
          dragging.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            group,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          if (!group) locate(e);
        }}
        onPointerMove={(e) => {
          const drag = dragging.current;
          if (!drag || drag.id !== e.pointerId) return;
          if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5)
            drag.moved = true;
          if (drag.moved || !drag.group) locate(e);
        }}
        onPointerUp={(e) => {
          const drag = dragging.current;
          if (!drag || drag.id !== e.pointerId) return;
          dragging.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          if (!drag.moved && drag.group) onGroup(drag.group);
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
        onLostPointerCapture={() => {
          dragging.current = null;
        }}
        onKeyDown={(e) => {
          const delta = e.shiftKey ? 180 : 80;
          if (e.key === "Home") {
            e.preventDefault();
            onFit();
          } else if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            onPan(
              e.key === "ArrowLeft"
                ? delta
                : e.key === "ArrowRight"
                  ? -delta
                  : 0,
              e.key === "ArrowUp" ? delta : e.key === "ArrowDown" ? -delta : 0,
            );
          }
        }}
      >
        <title>点击空白处或拖动定位；方向键平移，Home 显示全部站点</title>
        {islands.map((i) => (
          <g
            key={i.name}
            className={`group-color-${groupColorIndex(i.name)}`}
            style={groupColorStyle(i.name, groupColors)}
            role="button"
            tabIndex={0}
            data-mini-group={i.name}
            aria-label={`定位分组 ${i.name}`}
            // Pointer clicks are resolved above after distinguishing a drag.
            // Keep non-pointer activation (including assistive technology).
            onClick={(e) => {
              if (e.detail === 0) onGroup(i);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onGroup(i);
              }
            }}
          >
            <title>{i.name}</title>
            <rect
              x={i.x}
              y={i.y}
              width={i.width}
              height={i.height}
              rx={Math.min(i.width, i.height) * 0.3}
              className={`minimap-island island-${groupColorIndex(i.name)}`}
            />
          </g>
        ))}
        <rect
          ref={viewportRef}
          {...viewport}
          data-testid="minimap-viewport"
          className="minimap-viewport"
          pointerEvents="none"
        />
        {selectedNode && (
          <circle
            cx={selectedNode.x}
            cy={selectedNode.y}
            r={Math.max(domain.width / 75, 12)}
            className="minimap-selected"
            pointerEvents="none"
          />
        )}
      </svg>
      <p className="minimap-caption">分组大小不代表余额</p>
    </div>
  );
}
