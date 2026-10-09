"use client";
import { useId, useState } from "react";
import { Folder, FolderPlus } from "lucide-react";
import { savedGroupNames } from "@/lib/map-management";
import { AtlasSelect } from "./atlas-select";
import "./group-select.css";

export function GroupSelect({
  value,
  onValueChange,
  groups = [],
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  groups?: string[];
  disabled?: boolean;
}) {
  const [creating, setCreating] = useState(false),
    id = useId();
  const names = savedGroupNames(
    groups.map((group) => ({ group })),
    creating ? "" : value,
  );
  return (
    <div className="field group-select" data-testid="group-select">
      <label htmlFor={id}>分组</label>
      <input type="hidden" name="group" value={value} />
      <AtlasSelect
        id={id}
        label="分组"
        value={creating ? "new" : `group:${value || "未分组"}`}
        disabled={disabled}
        onValueChange={(choice) => {
          const fresh = choice === "new";
          setCreating(fresh);
          onValueChange(fresh ? "" : choice.slice(6));
        }}
        options={[
          ...names.map((name) => ({
            value: `group:${name}`,
            label: name,
            icon: <Folder size={16} />,
            group: "已有分组",
          })),
          {
            value: "new",
            label: "新建分组",
            description: "随站点保存，不创建空岛",
            icon: <FolderPlus size={16} />,
            group: "新分组",
          },
        ]}
      />
      {creating && (
        <div className="group-name-entry">
          <label htmlFor={`${id}-new`}>新分组名称</label>
          <input
            id={`${id}-new`}
            aria-label="新分组名称"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            maxLength={50}
            required
            pattern=".*\S.*"
            placeholder="例如：工作 / 实验"
            autoComplete="off"
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
