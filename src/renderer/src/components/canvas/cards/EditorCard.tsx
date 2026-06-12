/**
 * EditorCard — Canvas 上で 1 ファイルを Monaco で編集するカード。
 *
 * payload: { projectRoot, relPath }
 * 自前で files.read/write を呼び、dirty 管理 + Ctrl+S 保存。
 *
 * Issue #595: dirty な編集内容が × ボタンや Clear で確認なく失われる data-loss
 * バグを塞ぐため、mount 時に editor-card-dirty-registry へ snapshot provider
 * を登録する。これにより `useConfirmRemoveCard` / Canvas Clear が削除前に
 * dirty card 一覧を覗いて confirm dialog を出せる。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { EditorView } from '../../EditorView';
import { detectLanguage } from '../../../lib/language';
import { registerEditorCardDirty } from '../../../lib/editor-card-dirty-registry';
import type { CardDataOf, EditorCardPayload } from '../../../stores/canvas';
import { useNativeConfirm } from '../../../lib/use-native-confirm';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../lib/toast-context';

// Issue #732: payload 型は canvas store の判別可能 union に集約。`NodeProps` を
// `Node<CardDataOf<'editor'>>` で具体化することで `data.payload` が `EditorCardPayload`
// として読め、`unknown` からの型再構築 (inline cast) が不要になる。
function EditorCardImpl({ id, data }: NodeProps<Node<CardDataOf<'editor'>>>): JSX.Element {
  // payload 未設定の「空 EditorCard」もあり得るので空オブジェクトでフォールバックする
  // (旧 `(data?.payload ?? {}) as EditorPayload` と同一挙動。`{}` 既定なので
  //  projectRoot / relPath は undefined 扱いになり、既存の null チェックで吸収される)。
  const payload = (data?.payload ?? {}) as EditorCardPayload;
  const { projectRoot, relPath } = payload;
  const title = (data?.title as string) ?? relPath ?? 'Editor';
  const isImage = useMemo(
    () => (relPath ? detectLanguage(relPath) === 'image' : false),
    [relPath]
  );
  const t = useT();
  const confirm = useNativeConfirm();
  const { showToast } = useToast();
  const tRef = useRef(t);
  const showToastRef = useRef(showToast);
  useEffect(() => {
    tRef.current = t;
    showToastRef.current = showToast;
  }, [showToast, t]);

  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [isBinary, setIsBinary] = useState(false);
  const [lossyEncoding, setLossyEncoding] = useState(false);
  const [encoding, setEncoding] = useState('utf-8');
  const [mtimeMs, setMtimeMs] = useState<number | undefined>(undefined);
  const [sizeBytes, setSizeBytes] = useState<number | undefined>(undefined);
  const [contentHash, setContentHash] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot || !relPath) {
      setContent('');
      setOriginal('');
      setIsBinary(false);
      setLossyEncoding(false);
      setEncoding('utf-8');
      setMtimeMs(undefined);
      setSizeBytes(undefined);
      setContentHash(undefined);
      setLoading(false);
      return;
    }
    // Issue #325: 画像ファイルは files.read を呼ばず ImagePreview に委ねる。
    // バイナリを丸ごと UTF-8 lossy で読むコストを避けるため早期 return する。
    if (isImage) {
      setError(null);
      setLossyEncoding(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setLossyEncoding(false);
    setEncoding('utf-8');
    setMtimeMs(undefined);
    setSizeBytes(undefined);
    setContentHash(undefined);
    void window.api.files
      .read(projectRoot, relPath)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? 'failed to read');
        } else {
          const lossy = res.encoding === 'lossy';
          setContent(res.content);
          setOriginal(res.content);
          setIsBinary(res.isBinary);
          setLossyEncoding(lossy);
          setEncoding(res.encoding || 'utf-8');
          setMtimeMs(res.mtimeMs);
          setSizeBytes(res.sizeBytes);
          setContentHash(res.contentHash);
          setError(null);
          if (lossy) {
            showToastRef.current(tRef.current('editor.nonUtf8Warning', { path: relPath }), {
              tone: 'warning'
            });
          }
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectRoot, relPath, isImage]);

  const dirty = content !== original;

  // Issue #595: dirty 状態を Canvas モード共通の registry へ snapshot 経由で公開する。
  // ref を介すことで content/dirty が変わるたびに register を作り直さずに済み、
  // useConfirmRemoveCard / Canvas Clear の削除直前 lookup でも常に最新値を返せる。
  // relPath は「空 EditorCard」(payload.relPath = '') もあり得るので、空文字なら
  // title (= 'エディタ' / 'Editor') にフォールバックして confirm dialog で空白行が
  // 出ないようにする (`??` だと空文字を素通ししてしまうので `||` を使う)。
  const dirtySnapshotRef = useRef({ relPath: relPath || '', isDirty: false });
  dirtySnapshotRef.current = { relPath: relPath || title || '', isDirty: dirty };
  useEffect(() => {
    return registerEditorCardDirty(id, () => dirtySnapshotRef.current);
  }, [id]);

  const onSave = useCallback(async () => {
    if (!dirty) return;
    if (!projectRoot || !relPath || isBinary) return;
    if (lossyEncoding) {
      showToast(t('editor.nonUtf8SaveBlocked', { path: relPath }), { tone: 'warning' });
      return;
    }
    try {
      let res = await window.api.files.write(
        projectRoot,
        relPath,
        content,
        mtimeMs,
        sizeBytes,
        encoding,
        contentHash
      );
      if (res.conflict) {
        const overwrite = await confirm(t('editor.externalChangeConfirm', { path: relPath }));
        if (!overwrite) {
          showToast(t('editor.saveAborted', { path: relPath }), { tone: 'warning' });
          return;
        }
        res = await window.api.files.write(
          projectRoot,
          relPath,
          content,
          undefined,
          undefined,
          encoding,
          undefined
        );
      }
      if (!res.ok) {
        const message = res.error ?? 'failed to save';
        setError(message);
        showToast(t('editor.saveFailed', { error: message }), { tone: 'error' });
        return;
      }
      setOriginal(content);
      setMtimeMs(res.mtimeMs);
      setSizeBytes(res.sizeBytes);
      setContentHash(res.contentHash);
      setError(null);
      showToast(t('editor.saved', { path: relPath }), { tone: 'success' });
    } catch (err) {
      const message = String(err);
      setError(message);
      showToast(t('editor.saveFailed', { error: message }), { tone: 'error' });
    }
  }, [
    dirty,
    projectRoot,
    relPath,
    isBinary,
    lossyEncoding,
    content,
    mtimeMs,
    sizeBytes,
    encoding,
    contentHash,
    confirm,
    showToast,
    t
  ]);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#7a9eff' }} />
      <CardFrame id={id} title={isImage ? title : dirty ? `● ${title}` : title} accent="#7a9eff">
        <EditorView
          path={relPath}
          projectRoot={projectRoot}
          content={content}
          dirty={dirty}
          isBinary={isBinary}
          loading={loading}
          error={error}
          readOnly={lossyEncoding}
          readOnlyReason={lossyEncoding ? t('editor.nonUtf8ReadOnly') : undefined}
          onChange={setContent}
          onSave={() => void onSave()}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a9eff' }} />
    </>
  );
}

export default memo(EditorCardImpl);
