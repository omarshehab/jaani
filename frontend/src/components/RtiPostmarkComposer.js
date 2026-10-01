/**
 * RtiPostmarkComposer.js — Section 4, redesigned to match Sections 1-3's government-document
 * visual language (same GOV palette/typography as VerificationGrid.js) instead of the Gmail-style
 * MailCard.js UI. One composer card per resolved RTI office (mirrors Section 3's "one card per
 * office" pattern), each pre-addressed from that office's own Primary/Alternate officers
 * (বরাবর/green = Primary, অনুলিপি/maroon = Alternate — the same role colors Section 3 uses) and
 * with a button to generate a customized Form "ক" draft via AI for that specific office and
 * article.
 *
 * Transport is Postmark (POST /api/send-mail-postmark) — kept entirely separate from the
 * pre-existing Gmail OAuth send/draft path in MailCard.js, which is untouched and still
 * reachable via the "Gmail (OAuth)" toggle at the bottom, not deleted or modified.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Card, Typography, TextField, Button, IconButton, Stack, Divider, Chip, Collapse, Alert,
  CircularProgress, Tooltip,
} from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { sendMailPostmark, generateRtiApplicationDraft } from '../api/axiosConfig';

const GOV = {
  green: '#006a4e', greenLight: '#e8f5e9', greenDark: '#004d38',
  maroon: '#6a1b25', maroonLight: '#fbe9eb',
  gold: '#c5a55a', goldLight: '#fdf6e3',
  border: '#b9d3b0', bg: '#f7faf5', text: '#1b2e1b', textMuted: '#4b6043', white: '#ffffff',
};
const BN_FONT = '"Noto Serif Bengali", "Kalpurush", "SolaimanLipi", serif';

const APPLICANT_STORAGE_KEY = 'jaani_applicant_info_v1';

// The technical Postmark sending mailbox is a separate thing from the applicant's own email
// (item ১/৪ of the Form "ক" letter, where replies actually go) -- confirmed working end-to-end
// 2026-09-30 as a verified Postmark Sender Signature. omar.shehab.rti@gmail.com is NOT verified
// on this Postmark account, so it must never be the default "From" even though it's the
// applicant's own email in the letter body.
const DEFAULT_POSTMARK_FROM = 'shehab@hvts.ai';

// Pre-saved default applicant profile, from JAANI's own real, previously-submitted RTI
// application ("sample_RTIapplication to CPA- DP WORLD ,CTG - submitted.txt") -- a ready,
// legally-complete example rather than blank placeholders, editable by anyone who opens the
// panel. Only ever stored in the browser (localStorage), never sent anywhere except as part of
// the applicant's own outgoing application.
const DEFAULT_APPLICANT = {
  name: 'আবু মোহাম্মদ ওমর শেহাবউদ্দীন আইয়ুব',
  fatherName: 'মোহাম্মদ আইয়ুব',
  motherName: 'শাহেদা বেগম',
  address: '2704 Evergreen St., Yorktown Heights, NY 10598, USA',
  email: 'omar.shehab.rti@gmail.com',
  phone: '+১-৪৪৩-৫৩১-২৭২৭',
  citizenship: 'বাংলাদেশী',
};

function loadApplicantInfo() {
  try {
    const raw = localStorage.getItem(APPLICANT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { ...DEFAULT_APPLICANT };
  } catch {
    return { ...DEFAULT_APPLICANT };
  }
}

function officeKey(office) {
  return [office?.Ministry, office?.Division, office?.Office].join('|');
}

/* ── Applicant info — filled once, reused for every office's draft (§ item ১ and ৪) ── */
const ApplicantInfoPanel = ({ applicant, onChange }) => {
  const [open, setOpen] = useState(!applicant.name);
  const fields = [
    ['name', 'আবেদনকারীর নাম'],
    ['fatherName', 'পিতার নাম'],
    ['motherName', 'মাতার নাম'],
    ['address', 'বর্তমান ঠিকানা'],
    ['email', 'ইমেইল'],
    ['phone', 'ফোন'],
    ['citizenship', 'নাগরিকত্ব'],
  ];
  return (
    <Card elevation={0} sx={{ border: `1px solid ${GOV.border}`, borderRadius: '4px', mb: 2, bgcolor: GOV.white }}>
      <Box
        onClick={() => setOpen((o) => !o)}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1.25, cursor: 'pointer', bgcolor: GOV.goldLight }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <PersonRoundedIcon sx={{ fontSize: '1.1rem', color: GOV.gold }} />
          <Typography sx={{ fontFamily: BN_FONT, fontWeight: 700, fontSize: '0.88rem', color: GOV.text }}>
            আবেদনকারীর তথ্য {applicant.name ? `— ${applicant.name}` : '(একবার পূরণ করুন)'}
          </Typography>
        </Stack>
        {open ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
      </Box>
      <Collapse in={open}>
        <Box sx={{ p: 2 }}>
          <Stack direction="row" flexWrap="wrap" gap={1.5}>
            {fields.map(([key, label]) => (
              <TextField
                key={key}
                size="small"
                label={label}
                value={applicant[key] || ''}
                onChange={(e) => onChange({ ...applicant, [key]: e.target.value })}
                sx={{ flex: '1 1 220px', '& input': { fontFamily: BN_FONT } }}
              />
            ))}
          </Stack>
          <Typography sx={{ mt: 1, fontSize: '0.75rem', color: GOV.textMuted, fontFamily: BN_FONT }}>
            এই তথ্য শুধু আপনার ব্রাউজারে সংরক্ষিত হয় (localStorage) — সার্ভারে নয় — এবং প্রতিটি আবেদনের ফরম 'ক'-এর ১ ও ৪ নং ধারায় ব্যবহৃত হয়।
          </Typography>
        </Box>
      </Collapse>
    </Card>
  );
};

/* ── One composer card per resolved office ── */
const OfficeComposeCard = ({ office, articleText, applicant, defaultFrom, onSent }) => {
  const officeLabel = office.Office || office.Division || office.Ministry || 'অজানা দপ্তর';
  const [from, setFrom] = useState(defaultFrom || '');
  const [to, setTo] = useState(office.Primary_Email || '');
  const [cc, setCc] = useState(office.Alternate_Email || '');
  const [subject, setSubject] = useState(`তথ্য অধিকার আইনে তথ্য চাহিদাপত্র — ${officeLabel}`);
  const [bodyText, setBodyText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null); // {severity, message}
  const [section7, setSection7] = useState(null); // {flags:[{category,why}]} | null

  useEffect(() => { setFrom(defaultFrom || ''); }, [defaultFrom]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) => {
      const valid = accepted.filter((f) => f.size <= 25 * 1024 * 1024);
      if (valid.length) setAttachments((prev) => [...prev, ...valid]);
    },
    multiple: true,
    maxFiles: 10,
  });

  const handleGenerate = useCallback(async () => {
    if (!articleText) return;
    setGenerating(true);
    setStatus(null);
    setSection7(null);
    try {
      const result = await generateRtiApplicationDraft({ text: articleText, office, applicant });
      if (result?.success) {
        setBodyText(result.bodyText);
        setSection7(result.section7 || null);
      } else {
        setStatus({ severity: 'error', message: result?.error || 'খসড়া তৈরি ব্যর্থ হয়েছে' });
      }
    } catch (err) {
      setStatus({ severity: 'error', message: err?.response?.data?.error || err?.message || 'খসড়া তৈরি ব্যর্থ হয়েছে' });
    } finally {
      setGenerating(false);
    }
  }, [articleText, office, applicant]);

  const canSend = from.trim() && to.trim() && subject.trim() && bodyText.trim() && !sending;

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append('from', from.trim());
      fd.append('to', to.trim());
      if (cc.trim()) fd.append('cc', cc.trim());
      fd.append('subject', subject);
      fd.append('body_text', bodyText);
      fd.append('body_html', `<div style="white-space:pre-wrap;font-family:serif;">${bodyText.replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</div>`);
      attachments.forEach((f) => fd.append('files', f, f.name));

      const result = await sendMailPostmark(fd);
      if (result?.success) {
        setStatus({ severity: 'success', message: `পাঠানো হয়েছে — Message ID: ${result.message_id}` });
        onSent?.();
      } else if (result?.error === 'sender_not_verified') {
        setStatus({ severity: 'error', message: result.message });
      } else {
        setStatus({ severity: 'error', message: result?.message || result?.error || 'পাঠাতে ব্যর্থ হয়েছে' });
      }
    } catch (err) {
      const data = err?.response?.data;
      setStatus({ severity: 'error', message: data?.message || data?.error || err?.message || 'পাঠাতে ব্যর্থ হয়েছে' });
    } finally {
      setSending(false);
    }
  }, [canSend, from, to, cc, subject, bodyText, attachments, onSent]);

  return (
    <Card elevation={0} sx={{ border: `2px solid ${GOV.green}`, borderRadius: '4px', overflow: 'hidden', bgcolor: GOV.white, mb: 2.5 }}>
      <Box sx={{ background: `linear-gradient(135deg, ${GOV.greenDark} 0%, ${GOV.green} 60%, ${GOV.greenDark} 100%)`, px: 2, py: 1.1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <AccountBalanceIcon sx={{ fontSize: '1.1rem', color: GOV.gold }} />
        <Typography sx={{ fontFamily: BN_FONT, fontWeight: 800, fontSize: '0.88rem', color: GOV.white }}>{officeLabel}</Typography>
      </Box>

      <Box sx={{ p: 2 }}>
        <Stack spacing={1.25}>
          <TextField size="small" label="From (Postmark-এ যাচাইকৃত ঠিকানা)" value={from} onChange={(e) => setFrom(e.target.value)} fullWidth />
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="বরাবর (To)" value={to} onChange={(e) => setTo(e.target.value)} fullWidth
              sx={{ '& .MuiInputLabel-root': { color: GOV.green } }} />
            <TextField size="small" label="অনুলিপি (Cc)" value={cc} onChange={(e) => setCc(e.target.value)} fullWidth
              sx={{ '& .MuiInputLabel-root': { color: GOV.maroon } }} />
          </Stack>
          <TextField size="small" label="বিষয়" value={subject} onChange={(e) => setSubject(e.target.value)} fullWidth />

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              size="small" variant="outlined" onClick={handleGenerate} disabled={generating || !articleText}
              startIcon={generating ? <CircularProgress size={14} /> : <AutoAwesomeRoundedIcon sx={{ fontSize: '1rem' }} />}
              sx={{ textTransform: 'none', fontFamily: BN_FONT, borderColor: GOV.gold, color: GOV.greenDark, '&:hover': { borderColor: GOV.green, bgcolor: GOV.goldLight } }}
            >
              {generating ? 'তৈরি হচ্ছে...' : "AI দিয়ে ফরম 'ক' খসড়া তৈরি করুন"}
            </Button>
          </Box>

          {section7?.flags?.length > 0 && (
            <Alert severity="warning" sx={{ fontFamily: BN_FONT, fontSize: '0.8rem' }}>
              <Typography sx={{ fontWeight: 700, fontSize: '0.82rem', mb: 0.5, fontFamily: BN_FONT }}>
                ধারা ৭ অনুযায়ী আংশিক অব্যাহতির সম্ভাবনা আছে (তবে পুরো আবেদন প্রত্যাখ্যান করা যায় না, অব্যাহতিবহির্ভূত অংশ দিতে হবে):
              </Typography>
              {section7.flags.map((f, i) => (
                <Typography key={i} sx={{ fontSize: '0.78rem', fontFamily: BN_FONT }}>• {f.category} — {f.why}</Typography>
              ))}
            </Alert>
          )}

          <TextField
            multiline minRows={10} value={bodyText} onChange={(e) => setBodyText(e.target.value)}
            placeholder="উপরের বোতামে ক্লিক করে খসড়া তৈরি করুন, অথবা এখানে নিজে লিখুন..."
            fullWidth
            sx={{ '& textarea': { fontFamily: BN_FONT, fontSize: '0.85rem', whiteSpace: 'pre-wrap' } }}
          />

          <Box {...getRootProps()} sx={{ border: '1.5px dashed', borderColor: isDragActive ? GOV.green : GOV.border, borderRadius: '4px', p: 1.25, textAlign: 'center', cursor: 'pointer', bgcolor: isDragActive ? GOV.greenLight : GOV.bg }}>
            <input {...getInputProps()} />
            <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="center">
              <AttachFileRoundedIcon sx={{ fontSize: '1rem', color: GOV.textMuted }} />
              <Typography sx={{ fontFamily: BN_FONT, fontSize: '0.78rem', color: GOV.textMuted }}>
                সংযুক্তি যোগ করুন (সর্বোচ্চ ২৫ MB প্রতি ফাইল)
              </Typography>
            </Stack>
          </Box>
          {attachments.length > 0 && (
            <Stack direction="row" flexWrap="wrap" gap={0.75}>
              {attachments.map((f, i) => (
                <Chip key={`${f.name}-${i}`} size="small" label={f.name}
                  onDelete={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  deleteIcon={<CloseRoundedIcon sx={{ fontSize: '0.9rem' }} />}
                  sx={{ fontFamily: BN_FONT }} />
              ))}
            </Stack>
          )}

          {status && (
            <Alert severity={status.severity} icon={status.severity === 'success' ? <CheckCircleOutlineRoundedIcon /> : <ErrorOutlineRoundedIcon />} sx={{ fontFamily: BN_FONT }}>
              {status.message}
            </Alert>
          )}

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained" onClick={handleSend} disabled={!canSend}
              startIcon={sending ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <SendRoundedIcon sx={{ fontSize: '1rem' }} />}
              sx={{ textTransform: 'none', fontFamily: BN_FONT, fontWeight: 700, bgcolor: GOV.green, '&:hover': { bgcolor: GOV.greenDark }, borderRadius: '4px' }}
            >
              {sending ? 'পাঠানো হচ্ছে...' : 'Postmark দিয়ে পাঠান'}
            </Button>
          </Box>
        </Stack>
      </Box>
    </Card>
  );
};

/* ── Top-level Section 4 ── */
const RtiPostmarkComposer = ({ offices = [], articleText = '', defaultFrom = '', legacyMailCard = null }) => {
  const [applicant, setApplicant] = useState(loadApplicantInfo);
  const [showLegacy, setShowLegacy] = useState(false);

  const handleApplicantChange = useCallback((next) => {
    setApplicant(next);
    try { localStorage.setItem(APPLICANT_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const dedupedOffices = useMemo(() => {
    const seen = new Set();
    return (offices || []).filter((o) => {
      const k = officeKey(o);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [offices]);

  if (dedupedOffices.length === 0) return null;

  return (
    <Box sx={{ width: '100%', maxWidth: '960px', mx: 'auto', my: 4 }}>
      <Typography sx={{ fontFamily: BN_FONT, fontWeight: 800, fontSize: '1.05rem', color: GOV.greenDark, mb: 1.5 }}>
        ৪. তথ্য অধিকার আবেদন পাঠান
      </Typography>

      <ApplicantInfoPanel applicant={applicant} onChange={handleApplicantChange} />

      {dedupedOffices.map((office) => (
        <OfficeComposeCard
          key={officeKey(office)}
          office={office}
          articleText={articleText}
          applicant={applicant}
          defaultFrom={defaultFrom || DEFAULT_POSTMARK_FROM}
        />
      ))}

      {legacyMailCard && (
        <Box sx={{ mt: 1 }}>
          <Button
            size="small" onClick={() => setShowLegacy((v) => !v)}
            sx={{ textTransform: 'none', fontFamily: BN_FONT, color: GOV.textMuted, fontSize: '0.78rem' }}
          >
            {showLegacy ? '▲ Gmail (OAuth) অপশন লুকান' : '▼ পরিবর্তে Gmail (OAuth) দিয়ে পাঠাতে চান?'}
          </Button>
          <Collapse in={showLegacy}>
            <Box sx={{ mt: 1 }}>{legacyMailCard}</Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
};

export default RtiPostmarkComposer;
