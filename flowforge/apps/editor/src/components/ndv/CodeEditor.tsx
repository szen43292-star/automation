import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { memo, useMemo } from 'react';
import { useTheme } from '../../lib/theme';

function CodeEditorComponent({
  value,
  onChange,
  language,
  minRows = 6,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  language: 'js' | 'json' | 'text';
  minRows?: number;
  readOnly?: boolean;
}) {
  const dark = useTheme((s) => s.dark);
  const extensions = useMemo(
    () => (language === 'js' ? [javascript()] : language === 'json' ? [json()] : []),
    [language],
  );
  return (
    <div onKeyDown={(e) => e.stopPropagation()}>
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={dark ? 'dark' : 'light'}
        readOnly={readOnly}
        minHeight={`${minRows * 19}px`}
        maxHeight="520px"
        basicSetup={{
          lineNumbers: language === 'js',
          foldGutter: false,
          highlightActiveLine: language === 'js',
        }}
      />
    </div>
  );
}

export const CodeEditor = memo(CodeEditorComponent);
