import React, { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Container,
  Typography,
  TextField,
  Button,
  Stack,
  Link,
  IconButton,
  Divider,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import FacebookIcon from '@mui/icons-material/Facebook';
import TwitterIcon from '@mui/icons-material/Twitter';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import InstagramIcon from '@mui/icons-material/Instagram';

const Footer = () => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  const handleSubscribe = () => {
    if (email && email.includes('@')) {
      setSubscribed(true);
      setEmail('');
      setTimeout(() => setSubscribed(false), 3000);
    }
  };

  const sections = useMemo(() => ([
    {
      key: 'company',
      title: 'Company',
      links: [
        { href: '/about', label: 'About Us' },
        { href: '/team', label: 'Our Team' },
        { href: '/careers', label: 'Careers' },
        { href: '/press', label: 'Press Kit' },
        { href: '/contact', label: 'Contact' },
      ],
    },
    {
      key: 'resources',
      title: 'Resources',
      links: [
        { href: '/docs', label: 'Documentation' },
        { href: '/api', label: 'API Reference' },
        { href: '/faq', label: 'FAQs' },
        { href: '/blog', label: 'Blog' },
        { href: '/status', label: 'Status Page' },
      ],
    },
  ]), []);

  const FooterLink = ({ href, label }) => (
    <Link
      href={href}
      sx={{
        fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
        fontSize: '1.05rem',
        color: '#4F3E2A',
        textDecoration: 'none',
        display: 'block',
        mb: 2.2,
        transition: 'color 0.3s ease',
        '&:hover': {
          color: '#8B1212',
        }
      }}
    >
      {label}
    </Link>
  );

  return (
    <Box
      component="footer"
      sx={{
        backgroundColor: '#F6F1E5',
        pt: { xs: 5, md: 8 },
        pb: { xs: 4, md: 5 },
        px: { xs: 3, md: 6 },
        mt: 6,
        borderRadius: { xs: '32px', md: '64px' },
        border: 'none',
        overflow: 'hidden'
      }}
    >
      <Container maxWidth="xl" sx={{ px: { xs: 1, md: 4 } }}>
        <Stack spacing={{ xs: 4, md: 6 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr 1fr 1.5fr' },
              gap: { xs: 4, md: 6 },
            }}
          >
            <Stack spacing={2}>
              <Typography
                sx={{
                  fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                  fontSize: { xs: '2.5rem', md: '3.2rem' },
                  fontWeight: 700,
                  color: '#8B1212',
                  lineHeight: 1,
                  mb: 1
                }}
              >
                JAANI
              </Typography>
              <Typography
                sx={{
                  fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                  fontSize: '1.1rem',
                  color: '#4F3E2A',
                  lineHeight: 1.6,
                  maxWidth: '90%',
                  mb: 1
                }}
              >
                {t('footer.tagline', 'Sunlight is the best disinfectant. JAANI helps keep RTI communication transparent.')}
              </Typography>
              <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', mb: 2 }}>
                <Chip label="RTI" sx={{ backgroundColor: '#EADBC1', color: '#4F3E2A', fontWeight: 600, fontFamily: 'serif', px: 1, height: 32, '& .MuiChip-label': { px: 1.5 } }} />
                <Chip label="Gmail" sx={{ backgroundColor: '#EADBC1', color: '#4F3E2A', fontWeight: 600, fontFamily: 'serif', px: 1, height: 32, '& .MuiChip-label': { px: 1.5 } }} />
                <Chip label="Verifier" sx={{ backgroundColor: '#EADBC1', color: '#4F3E2A', fontWeight: 600, fontFamily: 'serif', px: 1, height: 32, '& .MuiChip-label': { px: 1.5 } }} />
              </Stack>
              <Stack direction="row" spacing={1.5}>
                {[FacebookIcon, TwitterIcon, LinkedInIcon, InstagramIcon].map((IconComp, idx) => (
                  <IconButton
                    key={idx}
                    sx={{
                      color: '#8B1212',
                      backgroundColor: '#EADBC1',
                      width: 40,
                      height: 40,
                      '&:hover': { backgroundColor: '#D8C6A5' },
                    }}
                  >
                    <IconComp fontSize="small" />
                  </IconButton>
                ))}
              </Stack>
            </Stack>

            {sections.map((section) => (
              <Stack spacing={0} key={section.key}>
                <Typography
                  sx={{
                    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                    fontWeight: 700,
                    fontSize: '1.3rem',
                    color: '#2F2418',
                    mb: 3,
                  }}
                >
                  {section.title}
                </Typography>
                {section.links.map((link) => (
                  <FooterLink key={link.href} href={link.href} label={link.label} />
                ))}
              </Stack>
            ))}

            <Stack spacing={0}>
              <Typography
                sx={{
                  fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                  fontWeight: 700,
                  fontSize: '1.3rem',
                  color: '#2F2418',
                  mb: 3,
                }}
              >
                Subscribe to Updates
              </Typography>
              <Typography
                sx={{
                  fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                  fontSize: '1.1rem',
                  color: '#4F3E2A',
                  lineHeight: 1.5,
                  mb: 3,
                }}
              >
                Get release notes and RTI feature updates.
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ width: '100%', mt: 'auto' }}>
                <Box sx={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <TextField
                    fullWidth
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSubscribe()}
                    disabled={subscribed}
                    variant="outlined"
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                        fontSize: '1.05rem',
                        backgroundColor: 'transparent',
                        borderRadius: '999px',
                        height: 52,
                        '& fieldset': { 
                          borderColor: '#D4C1A2',
                          borderWidth: '1.5px',
                        },
                        '&:hover fieldset': { borderColor: '#B59F7C' },
                        '&.Mui-focused fieldset': { borderColor: '#8B1212' },
                        '& input': {
                          px: 3,
                          py: 1.5,
                          '&::placeholder': {
                            color: '#9E8D73',
                            opacity: 1
                          }
                        }
                      },
                    }}
                  />
                </Box>
                <Button
                  onClick={handleSubscribe}
                  disabled={subscribed || !email}
                  sx={{
                    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                    fontWeight: 700,
                    fontSize: '1.1rem',
                    textTransform: 'none',
                    backgroundColor: '#C5B7A5',
                    color: '#FFFFFF',
                    px: 4,
                    height: 52,
                    borderRadius: '999px',
                    whiteSpace: 'nowrap',
                    boxShadow: 'none',
                    '&:hover': { 
                      backgroundColor: '#B5A591',
                      boxShadow: 'none',
                    },
                    '&:disabled': { 
                      backgroundColor: '#DCD3C6', 
                      color: '#FFFFFF' 
                    },
                  }}
                >
                  {subscribed ? '✓ Subscribed' : 'Subscribe'}
                </Button>
              </Stack>
            </Stack>
          </Box>
        </Stack>

        <Divider sx={{ my: { xs: 4, md: 5 }, borderColor: '#DCD3C6' }} />

        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'center', md: 'center' },
            gap: 3,
            pb: 2
          }}
        >
          <Typography
            sx={{
              fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
              fontSize: '1rem',
              color: '#6F5C43',
            }}
          >
            © 2026 JAANI. All rights reserved. <span style={{ margin: '0 8px', color: '#B5A591' }}>|</span> Sunlight is the best disinfectant
          </Typography>

          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: 'center' }}
          >
            <Link href="/privacy" sx={{ fontFamily: '"Noto Serif Bengali", "Kalpurush", serif', fontSize: '1rem', color: '#6F5C43', textDecoration: 'none', '&:hover': { color: '#8B1212' } }}>
              Privacy Policy
            </Link>
            <Box sx={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: '#C1B6A6' }} />
            <Link href="/terms" sx={{ fontFamily: '"Noto Serif Bengali", "Kalpurush", serif', fontSize: '1rem', color: '#6F5C43', textDecoration: 'none', '&:hover': { color: '#8B1212' } }}>
              Terms of Service
            </Link>
            <Box sx={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: '#C1B6A6' }} />
            <Link href="/cookies" sx={{ fontFamily: '"Noto Serif Bengali", "Kalpurush", serif', fontSize: '1rem', color: '#6F5C43', textDecoration: 'none', '&:hover': { color: '#8B1212' } }}>
              Cookie Policy
            </Link>
          </Stack>
        </Box>
      </Container>
    </Box>
  );
};

export default Footer;
