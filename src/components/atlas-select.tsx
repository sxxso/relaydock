"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, useId, type ReactNode } from "react";
import "./atlas-select.css";

type AtlasSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
};

// Encode every value, not just "", so a real value can never collide with it.
const VALUE_PREFIX = "atlas-select:";
const encodeValue = (value: string) => VALUE_PREFIX + value;

export function AtlasSelect({
  value,
  onValueChange,
  options,
  label,
  id,
  className,
  disabled = false,
  showMenuHeader = true,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: AtlasSelectOption[];
  label: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  /** Set false for a compact menu without the label and option count. */
  showMenuHeader?: boolean;
}) {
  const optionPrefix = useId();
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? label;
  // Group only adjacent entries: keyboard navigation keeps the caller's order.
  const sections: {
    group: string | undefined;
    entries: { option: AtlasSelectOption; index: number }[];
  }[] = [];
  options.forEach((option, index) => {
    const group = option.group?.trim() || undefined;
    const previous = sections[sections.length - 1];
    if (previous && previous.group === group) {
      previous.entries.push({ option, index });
    } else {
      sections.push({ group, entries: [{ option, index }] });
    }
  });

  const renderOption = (option: AtlasSelectOption, index: number) => {
    const copyId = `${optionPrefix}-copy-${index}`;
    const hasIcon = option.icon != null && typeof option.icon !== "boolean";

    // Name includes the visible description once; typeahead stays label-only.
    return (
      <Select.Item
        key={option.value}
        className="atlas-select-item"
        data-has-icon={hasIcon ? "true" : undefined}
        value={encodeValue(option.value)}
        textValue={option.label}
        aria-labelledby={copyId}
      >
        {hasIcon && (
          <span className="atlas-select-option-icon" aria-hidden="true">
            {option.icon}
          </span>
        )}
        <span id={copyId} className="atlas-select-copy">
          <Select.ItemText asChild>
            <span className="atlas-select-label">{option.label}</span>
          </Select.ItemText>
          {option.description && (
            <span className="atlas-select-description">
              {option.description}
            </span>
          )}
        </span>
        <Select.ItemIndicator className="atlas-select-check" aria-hidden="true">
          <Check size={13} strokeWidth={2.5} aria-hidden="true" />
        </Select.ItemIndicator>
      </Select.Item>
    );
  };

  return (
    <Select.Root
      value={encodeValue(value)}
      onValueChange={(nextValue) => {
        if (nextValue.startsWith(VALUE_PREFIX)) {
          onValueChange(nextValue.slice(VALUE_PREFIX.length));
        }
      }}
      disabled={disabled || options.length === 0}
    >
      <Select.Trigger
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        className={["atlas-select-trigger", className]
          .filter(Boolean)
          .join(" ")}
      >
        {selectedOption?.icon != null &&
          typeof selectedOption.icon !== "boolean" && (
            <span className="atlas-select-trigger-icon" aria-hidden="true">
              {selectedOption.icon}
            </span>
          )}
        {/* Radix Value intentionally ignores className; style its outer span. */}
        <span className="atlas-select-value" title={selectedLabel}>
          <Select.Value>{selectedLabel}</Select.Value>
        </span>
        <Select.Icon asChild>
          <span className="atlas-select-toggle" aria-hidden="true">
            <ChevronDown
              className="atlas-select-chevron"
              size={15}
              aria-hidden="true"
            />
          </span>
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          className="atlas-select-content"
          aria-label={label}
          position="popper"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          avoidCollisions
          sticky="partial"
          hideWhenDetached
        >
          {showMenuHeader && (
            // Decorative context, not another option or focus stop in the listbox.
            <div className="atlas-select-header" aria-hidden="true">
              <span className="atlas-select-heading">{label}</span>
              <span className="atlas-select-count">
                {options.length}
                <span className="atlas-select-count-unit">项</span>
              </span>
            </div>
          )}
          <Select.ScrollUpButton
            className="atlas-select-scroll"
            aria-hidden="true"
          >
            <ChevronUp size={15} aria-hidden="true" />
          </Select.ScrollUpButton>
          <Select.Viewport className="atlas-select-viewport">
            {sections.map((section) => (
              <Fragment key={section.entries[0].option.value}>
                {section.entries[0].index > 0 && (
                  <Select.Separator
                    className="atlas-select-separator"
                    aria-hidden="true"
                  />
                )}
                {section.group ? (
                  <Select.Group className="atlas-select-group">
                    <Select.Label className="atlas-select-group-label">
                      {section.group}
                    </Select.Label>
                    {section.entries.map(({ option, index }) =>
                      renderOption(option, index),
                    )}
                  </Select.Group>
                ) : (
                  section.entries.map(({ option, index }) =>
                    renderOption(option, index),
                  )
                )}
              </Fragment>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton
            className="atlas-select-scroll"
            aria-hidden="true"
          >
            <ChevronDown size={15} aria-hidden="true" />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
