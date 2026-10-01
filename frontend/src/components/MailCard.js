import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import {
  Box,
  Card,
  Typography,
  TextField,
  Button,
  IconButton,
  Stack,
  Divider,
  Chip,
  Paper,
  Tabs,
  Tab,
  Tooltip,
  Badge,
  Collapse,
  Alert,
  LinearProgress,
} from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DraftsRoundedIcon from '@mui/icons-material/DraftsRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import ImageRoundedIcon from '@mui/icons-material/ImageRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import MailOutlineRoundedIcon from '@mui/icons-material/MailOutlineRounded';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Helpers
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const FONT = '"Google Sans", "Inter", "Roboto", sans-serif';

const getFileIcon = (fileName) => {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext))
    return <ImageRoundedIcon sx={{ color: '#34A853', fontSize: '1.3rem' }} />;
  if (ext === 'pdf')
    return <PictureAsPdfRoundedIcon sx={{ color: '#EA4335', fontSize: '1.3rem' }} />;
  return <InsertDriveFileRoundedIcon sx={{ color: '#4285F4', fontSize: '1.3rem' }} />;
};

const formatFileSize = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
};

const htmlToPlainText = (html) => {
  try {
    const div = document.createElement('div');
    div.innerHTML = (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n');
    return (div.textContent || div.innerText || '').trim();
  } catch (_) {
    return (html || '').replace(/<[^>]*>/g, ' ').trim();
  }
};

const escapeHtml = (value = '') =>
  (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const templateToHtml = (template) => {
  if (!template) return '';
  if (template.format === 'html') return template.content || '';
  return escapeHtml(template.content || '').replace(/\r?\n/g, '<br/>');
};

/* ━━━ Compose instance factory ━━━ */
let _cid = 0;
const createInstance = (to = '', subject = '', body = '') => ({
  id: ++_cid,
  to,
  cc: '',
  bcc: '',
  subject,
  body,
  attachments: [],
  showCc: false,
  showBcc: false,
  status: 'composing', // composing | sent | drafted | error
  statusMessage: '',
});

/* ━━━ Quill config (constant — avoids re-render) ━━━ */
const QUILL_MODULES = {
  toolbar: [
    [{ font: [] }, { size: ['small', false, 'large', 'huge'] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ align: [] }],
    ['link', 'image', 'blockquote'],
    ['clean'],
  ],
};

const QUILL_FORMATS = [
  'font', 'size',
  'bold', 'italic', 'underline', 'strike',
  'color', 'background',
  'list', 'bullet',
  'indent', 'align',
  'link', 'image', 'blockquote',
];

const ACCEPTED_FILES = {
  'image/*': ['.jpeg', '.jpg', '.png', '.gif', '.webp', '.bmp'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/plain': ['.txt', '.csv', '.log'],
  'application/json': ['.json'],
  'application/zip': ['.zip'],
  'application/x-7z-compressed': ['.7z'],
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AttachmentItem
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const AttachmentItem = ({ file, onRemove }) => (
  <Paper
    elevation={0}
    sx={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      p: 1, mb: 0.75,
      backgroundColor: '#F1F3F4', border: '1px solid #E0E0E0', borderRadius: '8px',
      transition: 'all 0.15s',
      '&:hover': { borderColor: '#1A73E8', backgroundColor: '#E8F0FE' },
    }}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
      {getFileIcon(file.name)}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontFamily: FONT, fontWeight: 500, fontSize: '0.85rem', color: '#202124' }}>
          {file.name || 'Unnamed'}
        </Typography>
        <Typography sx={{ fontFamily: FONT, fontSize: '0.7rem', color: '#5F6368' }}>
          {formatFileSize(file.size)}
        </Typography>
      </Box>
    </Box>
    <IconButton
      size="small" onClick={onRemove}
      sx={{ color: '#5F6368', '&:hover': { backgroundColor: 'rgba(217,48,37,0.08)', color: '#D93025' } }}
    >
      <CloseRoundedIcon sx={{ fontSize: '1rem' }} />
    </IconButton>
  </Paper>
);

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ComposeForm (one per tab)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const ComposeForm = ({ instance, onUpdate, onSend, onSaveDraft, onDiscard, disabled, loadingProgress = 0, loadingEta = 'Calculating...', bodyTemplates = [], onApplyTemplate = () => {} }) => {
  const { to, cc, bcc, subject, body, attachments, showCc, showBcc, status, statusMessage } = instance;

  /* Dropzone (per-instance) */
  const onDrop = useCallback((accepted) => {
    const valid = accepted.filter((f) => {
      if (f.size > 25 * 1024 * 1024) {
        alert(`${f.name} exceeds Gmail's 25 MB limit.`);
        return false;
      }
      return true;
    });
    if (valid.length) onUpdate({ attachments: [...attachments, ...valid] });
  }, [attachments, onUpdate]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_FILES,
    maxFiles: 10,
    multiple: true,
    disabled,
  });

  const removeAttachment = useCallback(
    (idx) => onUpdate({ attachments: attachments.filter((_, i) => i !== idx) }),
    [attachments, onUpdate],
  );

  const hasTo = (to || '').trim().length > 0;
  const hasSubject = (subject || '').trim().length > 0;
  const hasBody = (body || '').replace(/<[^>]*>/g, '').trim().length > 0;
  const canAct = hasTo && hasSubject && hasBody && !disabled;
  const done = status === 'sent' || status === 'drafted';

  return (
    <Box sx={{ opacity: done ? 0.55 : 1, pointerEvents: done ? 'none' : 'auto' }}>
      {/* Status banner */}
      {statusMessage && (
        <Alert
          severity={status === 'sent' ? 'success' : status === 'drafted' ? 'info' : 'error'}
          icon={
            status === 'sent'
              ? <CheckCircleOutlineRoundedIcon />
              : status === 'error'
              ? <ErrorOutlineRoundedIcon />
              : undefined
          }
          sx={{ mb: 2, borderRadius: '8px', fontFamily: FONT }}
        >
          {statusMessage}
        </Alert>
      )}

      <Stack spacing={2}>
        {disabled && (
          <Box sx={{ mb: 0.5 }}>
            <LinearProgress
              variant="determinate"
              value={Math.max(1, Math.min(99, Math.round(loadingProgress || 0)))}
              sx={{
                height: 7,
                borderRadius: 6,
                backgroundColor: '#E8EAED',
                '& .MuiLinearProgress-bar': { backgroundColor: '#1A73E8', borderRadius: 6 },
              }}
            />
            <Typography sx={{ mt: 0.4, fontFamily: FONT, fontSize: '0.75rem', color: '#5F6368' }}>
              {Math.max(1, Math.min(99, Math.round(loadingProgress || 0)))}% complete • ETA: {loadingEta}
            </Typography>
          </Box>
        )}

        {/* ── To ── */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontFamily: FONT, fontWeight: 500, fontSize: '0.85rem', color: '#5F6368', minWidth: 36 }}>
            To
          </Typography>
          <TextField
            fullWidth value={to}
            onChange={(e) => onUpdate({ to: e.target.value })}
            placeholder="recipient@example.com"
            variant="standard" size="small" disabled={disabled}
            sx={{ '& .MuiInputBase-input': { fontFamily: FONT, fontSize: '0.9rem', color: '#202124' } }}
          />
          <Button
            onClick={() => onUpdate({ showCc: !showCc })} disabled={disabled}
            sx={{ textTransform: 'none', fontFamily: FONT, fontWeight: 500, color: '#1A73E8', minWidth: 'auto', px: 1 }}
          >
            Cc
          </Button>
          <Button
            onClick={() => onUpdate({ showBcc: !showBcc })} disabled={disabled}
            sx={{ textTransform: 'none', fontFamily: FONT, fontWeight: 500, color: '#1A73E8', minWidth: 'auto', px: 1 }}
          >
            Bcc
          </Button>
        </Box>

        {/* ── Cc ── */}
        <Collapse in={showCc}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontFamily: FONT, fontWeight: 500, fontSize: '0.85rem', color: '#5F6368', minWidth: 36 }}>Cc</Typography>
            <TextField
              fullWidth value={cc} onChange={(e) => onUpdate({ cc: e.target.value })}
              placeholder="cc@example.com" variant="standard" size="small" disabled={disabled}
              sx={{ '& .MuiInputBase-input': { fontFamily: FONT, fontSize: '0.9rem' } }}
            />
          </Box>
        </Collapse>

        {/* ── Bcc ── */}
        <Collapse in={showBcc}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontFamily: FONT, fontWeight: 500, fontSize: '0.85rem', color: '#5F6368', minWidth: 36 }}>Bcc</Typography>
            <TextField
              fullWidth value={bcc} onChange={(e) => onUpdate({ bcc: e.target.value })}
              placeholder="bcc@example.com" variant="standard" size="small" disabled={disabled}
              sx={{ '& .MuiInputBase-input': { fontFamily: FONT, fontSize: '0.9rem' } }}
            />
          </Box>
        </Collapse>

        <Divider />

        {/* ── Subject ── */}
        <TextField
          fullWidth value={subject}
          onChange={(e) => onUpdate({ subject: e.target.value })}
          placeholder="Subject" variant="standard" disabled={disabled}
          sx={{ '& .MuiInputBase-input': { fontFamily: FONT, fontSize: '0.95rem', color: '#202124', fontWeight: 500 } }}
        />

        <Divider />

        {Array.isArray(bodyTemplates) && bodyTemplates.length > 0 && (
          <>
            <Box>
              <Typography sx={{ fontFamily: FONT, fontWeight: 600, fontSize: '0.8rem', color: '#3C4043', mb: 0.8 }}>
                Pre-saved formal templates
              </Typography>
              <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap">
                {bodyTemplates.map((template) => (
                  <Chip
                    key={template.filename}
                    label={template.filename.replace(/\.(txt|rtf|docx)$/i, '')}
                    onClick={() => onApplyTemplate(template)}
                    clickable
                    size="small"
                    sx={{
                      borderRadius: '8px',
                      fontFamily: FONT,
                      fontWeight: 500,
                      backgroundColor: '#EEF3FD',
                      border: '1px solid #D5E3FA',
                      color: '#1A73E8',
                      '&:hover': { backgroundColor: '#E2ECFD' },
                    }}
                  />
                ))}
              </Stack>
            </Box>
            <Divider />
          </>
        )}

        {/* ── Rich Text Body (ReactQuill) ── */}
        <Box
          sx={{
            border: '1px solid #E0E0E0', borderRadius: '8px', overflow: 'hidden', backgroundColor: '#fff',
            '& .ql-toolbar': {
              backgroundColor: '#F8F9FA', borderBottom: '1px solid #E0E0E0',
              borderTop: 'none', borderLeft: 'none', borderRight: 'none',
            },
            '& .ql-container': {
              border: 'none', minHeight: '200px',
              fontFamily: FONT, fontSize: '0.9rem',
            },
            '& .ql-editor': { minHeight: '200px', lineHeight: 1.6 },
            '& .ql-editor.ql-blank::before': { color: '#9AA0A6', fontStyle: 'normal' },
          }}
        >
          <ReactQuill
            theme="snow"
            value={body}
            onChange={(val) => onUpdate({ body: val })}
            placeholder="Compose your email..."
            readOnly={disabled}
            modules={QUILL_MODULES}
            formats={QUILL_FORMATS}
          />
        </Box>

        <Divider />

        {/* ── Attachments ── */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <AttachFileRoundedIcon sx={{ fontSize: '1.1rem', color: '#5F6368' }} />
            <Typography sx={{ fontFamily: FONT, fontWeight: 600, fontSize: '0.85rem', color: '#3C4043' }}>
              Attachments {attachments.length > 0 && `(${attachments.length})`}
            </Typography>
          </Box>

          <Box
            {...getRootProps()}
            sx={{
              border: '2px dashed',
              borderColor: isDragActive ? '#1A73E8' : '#DADCE0',
              borderRadius: '8px', p: 2.5, textAlign: 'center', cursor: 'pointer',
              backgroundColor: isDragActive ? '#E8F0FE' : '#FAFAFA',
              transition: 'all 0.2s',
              '&:hover': { borderColor: '#1A73E8', backgroundColor: '#F0F6FF' },
            }}
          >
            <input {...getInputProps()} />
            <UploadFileRoundedIcon sx={{ fontSize: '2rem', color: isDragActive ? '#1A73E8' : '#BDBDBD', mb: 0.5 }} />
            <Typography sx={{ fontFamily: FONT, fontSize: '0.85rem', color: isDragActive ? '#1A73E8' : '#5F6368', fontWeight: 500 }}>
              {isDragActive ? 'Drop files here' : 'Drag & drop files, or click to browse'}
            </Typography>
            <Typography sx={{ fontFamily: FONT, fontSize: '0.72rem', color: '#9AA0A6', mt: 0.5 }}>
              Max 25 MB per file &bull; Up to 10 files
            </Typography>
          </Box>

          {attachments.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              {attachments.map((file, idx) => (
                <AttachmentItem key={`${file.name}-${idx}`} file={file} onRemove={() => removeAttachment(idx)} />
              ))}
            </Box>
          )}
        </Box>

        <Divider />

        {/* ── Actions ── */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1.5}>
            <Button
              variant="contained" onClick={onSend} disabled={!canAct}
              startIcon={<SendRoundedIcon sx={{ fontSize: '1rem' }} />}
              sx={{
                fontFamily: FONT, fontWeight: 600, fontSize: '0.9rem',
                textTransform: 'none', backgroundColor: '#1A73E8', color: '#fff',
                borderRadius: '20px', px: 3, py: 0.85,
                '&:hover': { backgroundColor: '#1557B0' },
                '&:disabled': { backgroundColor: '#DADCE0', color: '#80868B' },
              }}
            >
              {disabled ? 'Sending…' : 'Send'}
            </Button>
            <Button
              variant="outlined" onClick={onSaveDraft} disabled={!canAct}
              startIcon={<DraftsRoundedIcon sx={{ fontSize: '1rem' }} />}
              sx={{
                fontFamily: FONT, fontWeight: 600, fontSize: '0.85rem',
                textTransform: 'none', color: '#1A73E8', borderColor: '#DADCE0',
                borderRadius: '20px', px: 2.5, py: 0.7,
                '&:hover': { backgroundColor: '#F1F3F4', borderColor: '#1A73E8' },
              }}
            >
              {disabled ? 'Saving…' : 'Save Draft'}
            </Button>
          </Stack>
          <Tooltip title="Discard this compose">
            <IconButton
              onClick={onDiscard} disabled={disabled}
              sx={{ color: '#5F6368', '&:hover': { color: '#D93025', backgroundColor: 'rgba(217,48,37,0.04)' } }}
            >
              <DeleteOutlineRoundedIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Stack>
    </Box>
  );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MailCard — Gmail-style multi-compose controller
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const MailCard = ({
  senderEmail = '',
  onSenderEmailChange = () => {},
  gmailConnectedEmail = null,
  onConnectGmail = () => {},
  initialRecipients = [''],
  defaultSubject = '',
  defaultBody = '',
  onSaveDraft = async () => ({ success: false }),
  onSendEmail = async () => ({ success: false }),
  isLoading = false,
  loadingProgress = 0,
  loadingEta = 'Calculating...',
  bodyTemplates = [],
}) => {
  const [instances, setInstances] = useState([]);
  const [activeTab, setActiveTab] = useState(0);
  const [bulkBusy, setBulkBusy] = useState(false);
  const prevKeyRef = useRef('');

  /* ── Initialise instances when recipients change ── */
  useEffect(() => {
    const recipients = (Array.isArray(initialRecipients) ? initialRecipients : []).filter(Boolean);
    const key = recipients.join('|||');
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;

    if (recipients.length > 0) {
      setInstances([createInstance(recipients[0], defaultSubject, defaultBody)]);
    } else {
      setInstances([createInstance('', defaultSubject, defaultBody)]);
    }
    setActiveTab(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecipients]);

  /* ── Available recipients not yet added ── */
  const availableRecipients = useMemo(() => {
    const used = new Set(instances.map((i) => (i.to || '').toLowerCase().trim()));
    return (Array.isArray(initialRecipients) ? initialRecipients : []).filter(
      (e) => e && !used.has(e.toLowerCase().trim()),
    );
  }, [instances, initialRecipients]);

  /* ── Instance CRUD ── */
  const updateInstance = useCallback((id, upd) => {
    setInstances((prev) => prev.map((i) => (i.id === id ? { ...i, ...upd } : i)));
  }, []);

  const addCompose = useCallback(() => {
    const nextEmail = availableRecipients[0] || '';
    setInstances((prev) => {
      const updated = [...prev, createInstance(nextEmail, defaultSubject, defaultBody)];
      setActiveTab(updated.length - 1);
      return updated;
    });
  }, [availableRecipients, defaultSubject, defaultBody]);

  const discardInstance = useCallback(
    (id) => {
      setInstances((prev) => {
        const next = prev.filter((i) => i.id !== id);
        const result = next.length ? next : [createInstance('', defaultSubject, defaultBody)];
        setActiveTab((t) => Math.max(0, Math.min(t, result.length - 1)));
        return result;
      });
    },
    [defaultSubject, defaultBody],
  );

  const applyTemplateToInstance = useCallback((id, template) => {
    const html = templateToHtml(template);
    if (!html) return;

    setInstances((prev) =>
      prev.map((instance) => {
        if (instance.id !== id) return instance;
        const hasExistingBody = (instance.body || '').replace(/<[^>]*>/g, '').trim().length > 0;
        return {
          ...instance,
          body: hasExistingBody ? `${instance.body}<p><br/></p>${html}` : html,
        };
      })
    );
  }, []);

  /* ── Extract compose data from an instance ── */
  const extractData = (inst) => ({
    to: inst.to,
    cc: inst.cc,
    bcc: inst.bcc,
    subject: inst.subject,
    bodyHtml: inst.body,
    bodyText: htmlToPlainText(inst.body),
    attachments: inst.attachments,
  });

  /* ── Single send ── */
  const handleSend = useCallback(
    async (id) => {
      const inst = instances.find((i) => i.id === id);
      if (!inst) return;
      const result = await onSendEmail(extractData(inst));
      if (result?.connecting) return; // OAuth in progress
      updateInstance(
        id,
        result?.success
          ? { status: 'sent', statusMessage: '✅ Email sent successfully!' }
          : { status: 'error', statusMessage: result?.error || 'Failed to send' },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instances, onSendEmail, updateInstance],
  );

  /* ── Single draft ── */
  const handleDraft = useCallback(
    async (id) => {
      const inst = instances.find((i) => i.id === id);
      if (!inst) return;
      const result = await onSaveDraft(extractData(inst));
      if (result?.connecting) return;
      updateInstance(
        id,
        result?.success
          ? { status: 'drafted', statusMessage: '✅ Draft saved to Gmail!' }
          : { status: 'error', statusMessage: result?.error || 'Failed to save draft' },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instances, onSaveDraft, updateInstance],
  );

  /* ── Bulk send all ── */
  const handleSendAll = useCallback(async () => {
    const composing = instances.filter((i) => i.status === 'composing');
    if (!composing.length) return;
    setBulkBusy(true);
    try {
      for (const inst of composing) {
        const result = await onSendEmail(extractData(inst), { openWindow: false });
        if (result?.connecting || result?.needsAuth) break;
        updateInstance(
          inst.id,
          result?.success
            ? { status: 'sent', statusMessage: '✅ Sent!' }
            : { status: 'error', statusMessage: result?.error || 'Failed' },
        );
      }
    } finally {
      setBulkBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances, onSendEmail, updateInstance]);

  /* ── Bulk draft all ── */
  const handleDraftAll = useCallback(async () => {
    const composing = instances.filter((i) => i.status === 'composing');
    if (!composing.length) return;
    setBulkBusy(true);
    try {
      for (const inst of composing) {
        const result = await onSaveDraft(extractData(inst), { openWindow: false });
        if (result?.connecting || result?.needsAuth) break;
        updateInstance(
          inst.id,
          result?.success
            ? { status: 'drafted', statusMessage: '✅ Draft saved!' }
            : { status: 'error', statusMessage: result?.error || 'Failed' },
        );
      }
    } finally {
      setBulkBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances, onSaveDraft, updateInstance]);

  const composingCount = instances.filter((i) => i.status === 'composing').length;
  const globalDisabled = isLoading || bulkBusy;

  /* ━━━━━━━━━━━━━━━━━ RENDER ━━━━━━━━━━━━━━━━━ */
  return (
    <Box sx={{ width: '100%', maxWidth: '960px', mx: 'auto', my: 4 }}>
      <Card
        sx={{
          borderRadius: '12px',
          boxShadow: '0 2px 14px rgba(0,0,0,0.08)',
          overflow: 'hidden',
          border: '1px solid #E0E0E0',
        }}
      >
        {/* ─── Header (blue gradient) ─── */}
        <Box
          sx={{
            px: { xs: 2, md: 3 }, py: 1.5,
            background: 'linear-gradient(135deg, #1A73E8 0%, #4285F4 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <MailOutlineRoundedIcon sx={{ color: '#fff', fontSize: '1.3rem' }} />
            <Typography sx={{ fontFamily: FONT, fontWeight: 700, fontSize: '1.05rem', color: '#fff' }}>
              Compose
            </Typography>
            {instances.length > 1 && (
              <Chip
                size="small" label={`${instances.length} recipients`}
                sx={{ fontWeight: 600, backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: '0.75rem' }}
              />
            )}
          </Box>
          {gmailConnectedEmail ? (
            <Chip
              size="small"
              icon={<CheckCircleOutlineRoundedIcon sx={{ color: '#fff !important', fontSize: '1rem' }} />}
              label={gmailConnectedEmail}
              sx={{ fontWeight: 600, backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff', fontFamily: FONT, fontSize: '0.78rem' }}
            />
          ) : (
            <Chip size="small" label="Not connected" sx={{ fontWeight: 600, backgroundColor: 'rgba(255,200,200,0.3)', color: '#fff' }} />
          )}
        </Box>

        {/* ─── From + Connect (shared across all composes) ─── */}
        <Box sx={{ px: { xs: 2, md: 3 }, py: 1.5, backgroundColor: '#F8F9FA', borderBottom: '1px solid #E8EAED' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontFamily: FONT, fontWeight: 500, fontSize: '0.85rem', color: '#5F6368', minWidth: 44 }}>
              From
            </Typography>
            <TextField
              fullWidth value={senderEmail}
              onChange={(e) => onSenderEmailChange(e.target.value)}
              variant="standard" placeholder="your.email@gmail.com" size="small" disabled={globalDisabled}
              sx={{ '& .MuiInputBase-input': { fontFamily: FONT, fontSize: '0.9rem', color: '#202124' } }}
            />
            <Button
              onClick={onConnectGmail}
              disabled={globalDisabled || !(senderEmail || '').trim()}
              sx={{
                textTransform: 'none', fontFamily: FONT, fontWeight: 600,
                color: '#1A73E8', whiteSpace: 'nowrap', fontSize: '0.85rem',
              }}
            >
              {gmailConnectedEmail ? 'Reconnect' : 'Verify / Connect'}
            </Button>
          </Box>
        </Box>

        {/* ─── Tabs (one per compose instance) ─── */}
        {instances.length > 0 && (
          <Box sx={{ borderBottom: '1px solid #E8EAED', backgroundColor: '#fff' }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Tabs
                value={Math.min(activeTab, instances.length - 1)}
                onChange={(_, v) => setActiveTab(v)}
                variant="scrollable" scrollButtons="auto"
                sx={{
                  flex: 1, minHeight: 42,
                  '& .MuiTab-root': {
                    fontFamily: FONT, fontWeight: 500, fontSize: '0.82rem',
                    textTransform: 'none', minHeight: 42, px: 2, color: '#5F6368',
                    '&.Mui-selected': { color: '#1A73E8', fontWeight: 600 },
                  },
                  '& .MuiTabs-indicator': { backgroundColor: '#1A73E8', height: 3, borderRadius: '3px 3px 0 0' },
                }}
              >
                {instances.map((inst, idx) => {
                  const label = (inst.to || '').trim() || `Compose ${idx + 1}`;
                  const short = label.length > 28 ? label.substring(0, 25) + '…' : label;

                  const icon =
                    inst.status === 'sent'
                      ? <CheckCircleOutlineRoundedIcon sx={{ fontSize: '0.9rem', color: '#34A853', mr: 0.5 }} />
                      : inst.status === 'drafted'
                      ? <DraftsRoundedIcon sx={{ fontSize: '0.9rem', color: '#FBBC04', mr: 0.5 }} />
                      : inst.status === 'error'
                      ? <ErrorOutlineRoundedIcon sx={{ fontSize: '0.9rem', color: '#EA4335', mr: 0.5 }} />
                      : inst.attachments.length > 0
                      ? (
                          <Badge
                            badgeContent={inst.attachments.length} color="primary"
                            sx={{ mr: 0.75, '& .MuiBadge-badge': { fontSize: '0.6rem', minWidth: 15, height: 15 } }}
                          >
                            <MailOutlineRoundedIcon sx={{ fontSize: '0.9rem' }} />
                          </Badge>
                        )
                      : null;

                  return (
                    <Tab
                      key={inst.id}
                      label={
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          {icon}
                          <span>{short}</span>
                        </Box>
                      }
                    />
                  );
                })}
              </Tabs>

              <Tooltip title={availableRecipients.length > 0 ? `Add: ${availableRecipients[0]}` : 'Add new compose'}>
                <IconButton
                  onClick={addCompose} disabled={globalDisabled} size="small"
                  sx={{ mr: 1, color: '#1A73E8', '&:hover': { backgroundColor: '#E8F0FE' } }}
                >
                  <AddRoundedIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}

        {/* ─── Compose forms (render all, display only active) ─── */}
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          {instances.map((inst, idx) => (
            <Box key={inst.id} sx={{ display: activeTab === idx ? 'block' : 'none' }}>
              <ComposeForm
                instance={inst}
                onUpdate={(upd) => updateInstance(inst.id, upd)}
                onSend={() => handleSend(inst.id)}
                onSaveDraft={() => handleDraft(inst.id)}
                onDiscard={() => discardInstance(inst.id)}
                disabled={globalDisabled}
                loadingProgress={loadingProgress}
                loadingEta={loadingEta}
                bodyTemplates={bodyTemplates}
                onApplyTemplate={(template) => applyTemplateToInstance(inst.id, template)}
              />
            </Box>
          ))}
        </Box>

        {/* ─── Bulk actions (shown when multiple composes remain) ─── */}
        {instances.length > 1 && composingCount > 1 && (
          <Box
            sx={{
              px: { xs: 2, md: 3 }, py: 1.5,
              borderTop: '1px solid #E8EAED', backgroundColor: '#F8F9FA',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1.5,
            }}
          >
            <Typography sx={{ fontFamily: FONT, fontSize: '0.8rem', color: '#5F6368', mr: 'auto' }}>
              {composingCount} compose{composingCount !== 1 ? 's' : ''} remaining
            </Typography>
            <Button
              variant="outlined" onClick={handleSendAll} disabled={globalDisabled}
              startIcon={<SendRoundedIcon sx={{ fontSize: '0.9rem' }} />}
              sx={{
                fontFamily: FONT, fontWeight: 600, fontSize: '0.8rem',
                textTransform: 'none', color: '#1A73E8', borderColor: '#DADCE0', borderRadius: '20px', px: 2,
                '&:hover': { backgroundColor: '#E8F0FE', borderColor: '#1A73E8' },
              }}
            >
              Send All
            </Button>
            <Button
              variant="outlined" onClick={handleDraftAll} disabled={globalDisabled}
              startIcon={<DraftsRoundedIcon sx={{ fontSize: '0.9rem' }} />}
              sx={{
                fontFamily: FONT, fontWeight: 600, fontSize: '0.8rem',
                textTransform: 'none', color: '#5F6368', borderColor: '#DADCE0', borderRadius: '20px', px: 2,
                '&:hover': { backgroundColor: '#F1F3F4', borderColor: '#5F6368' },
              }}
            >
              Draft All
            </Button>
          </Box>
        )}
      </Card>
    </Box>
  );
};

export default MailCard;
