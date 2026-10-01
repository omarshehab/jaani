import { createTheme } from '@mui/material/styles';

const palette = {
  primary: '#8B1212',
  secondary: '#7C5C2B',
  ink: '#2E2419',
  charcoal: '#4D4030',
  muted: '#8D7C65',
  background: '#F5EEDC',
  paper: '#FFFFFF',
  border: '#D8C5A5',
  outline: '#C8B392',
  accent: '#A77A34',
  softPaper: '#FBF5E8',
};

const typography = {
  fontFamily: [
    '"Noto Serif Bengali"',
    '"Kalpurush"',
    '"Noto Serif"',
    '"Inter"',
    '"Roboto"',
    'sans-serif',
  ].join(','),
  h1: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 700,
    fontSize: '3.6rem',
    letterSpacing: '0.01em',
    lineHeight: 1.15,
  },
  h2: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 600,
    fontSize: '2.45rem',
    letterSpacing: '0.01em',
    lineHeight: 1.2,
  },
  h3: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 600,
    fontSize: '1.9rem',
    lineHeight: 1.2,
  },
  h4: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 600,
    fontSize: '1.5rem',
  },
  h5: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 600,
    fontSize: '1.25rem',
  },
  h6: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontWeight: 600,
    fontSize: '1rem',
    letterSpacing: '0.05em',
  },
  subtitle1: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontSize: '1.1rem',
    fontWeight: 500,
    letterSpacing: '0.03em',
  },
  body1: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", "Noto Serif", sans-serif',
    fontSize: '1rem',
    lineHeight: 1.75,
    color: palette.ink,
  },
  body2: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", "Noto Serif", sans-serif',
    fontSize: '0.9375rem',
    lineHeight: 1.7,
    color: palette.charcoal,
  },
  button: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    textTransform: 'none',
    fontWeight: 600,
    fontSize: '0.95rem',
    letterSpacing: '0.02em',
  },
  caption: {
    fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
    fontSize: '0.75rem',
    letterSpacing: '0.04em',
  },
};

const radii = {
  pill: 120,
  xl: 32,
  lg: 20,
  md: 16,
  sm: 8.5,
};

const shadows = {
  floating: '0px 20px 40px rgba(46, 36, 25, 0.1)',
  medium: '0px 14px 30px rgba(46, 36, 25, 0.12)',
  card: '0px 10px 24px rgba(46, 36, 25, 0.08)',
  input: '0px 4px 12px rgba(46, 36, 25, 0.07)',
  button: '0px 10px 24px rgba(139, 18, 18, 0.25)',
};

const theme = createTheme({
  palette: {
    primary: {
      main: palette.primary,
      contrastText: '#FFFFFF',
    },
    secondary: {
      main: palette.secondary,
      contrastText: '#030303',
    },
    background: {
      default: palette.background,
      paper: palette.softPaper,
    },
    text: {
      primary: palette.ink,
      secondary: palette.charcoal,
    },
    divider: palette.border,
    info: {
      main: palette.accent,
    },
    success: {
      main: '#355E3B',
    },
  },
  typography,
  shape: {
    borderRadius: radii.lg,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: palette.background,
          color: palette.ink,
          backgroundImage:
            'linear-gradient(rgba(255, 255, 255, 0.5), rgba(245, 238, 220, 0.5)), url(/jaani-site-bg.png)',
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundAttachment: 'fixed',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(251, 245, 232, 0.9)',
          backdropFilter: 'blur(24px)',
          borderBottom: `1px solid ${palette.border}`,
          boxShadow: 'none',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: radii.xl,
          padding: '12px 28px',
          boxShadow: 'none',
          transition: 'transform 180ms ease, box-shadow 180ms ease',
          '&:hover': {
            transform: 'translateY(-1px)',
            boxShadow: shadows.button,
          },
        },
        containedPrimary: {
          boxShadow: shadows.button,
        },
      },
    },
    MuiFab: {
      styleOverrides: {
        root: {
          boxShadow: shadows.button,
          backgroundColor: palette.primary,
          '&:hover': {
            backgroundColor: palette.primary,
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: radii.pill,
          backgroundColor: palette.softPaper,
          boxShadow: shadows.input,
          paddingRight: '18px',
          '& fieldset': {
            borderColor: palette.border,
          },
          '&.Mui-focused fieldset': {
            borderColor: palette.primary,
            borderWidth: 2,
          },
        },
        input: {
          padding: '22px 28px',
          fontSize: '1.1rem',
          fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: radii.lg,
          border: `1px solid ${palette.border}`,
          backgroundColor: palette.softPaper,
          boxShadow: shadows.card,
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          borderRadius: radii.lg,
          marginBottom: '24px',
          border: `1px solid ${palette.border}`,
          backgroundColor: palette.softPaper,
          boxShadow: 'none',
          '&:before': {
            display: 'none',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: radii.md,
          borderColor: palette.outline,
          backgroundColor: '#F4E9D2',
          color: palette.charcoal,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: radii.lg,
          boxShadow: shadows.card,
          border: `1px solid ${palette.border}`,
          backgroundColor: palette.softPaper,
        },
      },
    },
  },
});

export const themeUtils = {
  palette,
  typography,
  radii,
  shadows,
};

export default theme;
