export interface SourceEditorProps {
  value: string;
  onChange(value: string): void;
  onSave(): void;
  readOnly: boolean;
  label: string;
  workspaceKey: string;
  cwd: string;
  path: string;
  mobile?: boolean;
}

export function PlainTextEditor({ value, onChange, onSave, readOnly, label, mobile }: SourceEditorProps) {
  return <textarea
    aria-label={label}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    }}
    readOnly={readOnly}
    spellCheck={false}
    autoCapitalize="off"
    autoCorrect="off"
    wrap="off"
    className={`thin-scroll min-h-0 flex-1 resize-none bg-canvas p-3 font-mono leading-6 text-ink outline-none ${mobile ? "text-base" : "text-sm"}`}
  />;
}
