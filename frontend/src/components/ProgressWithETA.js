import React from 'react';
import {
  Box,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';

const ProgressWithETA = ({
  active = false,
  label = 'Loading...',
  helper = '',
  progress = 0,
  etaText = 'Calculating...',
  compact = false,
}) => {
  if (!active) return null;

  const normalized = Math.max(1, Math.min(99, Math.round(progress || 0)));

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: compact ? 520 : 640,
        mx: 'auto',
        px: compact ? 1 : 2,
      }}
    >
      <Stack
        direction={compact ? 'row' : 'column'}
        spacing={compact ? 1.2 : 1.5}
        alignItems={compact ? 'center' : 'stretch'}
      >
        {!compact && (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <CircularProgress size={36} thickness={5} sx={{ color: '#8B1212' }} />
          </Box>
        )}

        <Box sx={{ width: '100%' }}>
          <Typography
            sx={{
              fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
              fontWeight: 600,
              fontSize: compact ? '0.9rem' : '1rem',
              color: '#8B1212',
              textAlign: compact ? 'left' : 'center',
              mb: 0.6,
            }}
          >
            {label}
          </Typography>

          <LinearProgress
            variant="determinate"
            value={normalized}
            sx={{
              height: compact ? 7 : 9,
              borderRadius: 6,
              backgroundColor: '#EADFCF',
              '& .MuiLinearProgress-bar': {
                borderRadius: 6,
                backgroundColor: '#8B1212',
              },
            }}
          />

          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
            <Typography sx={{ fontSize: compact ? '0.76rem' : '0.82rem', color: '#5D4B34', fontWeight: 600 }}>
              {normalized}% complete
            </Typography>
            <Typography sx={{ fontSize: compact ? '0.76rem' : '0.82rem', color: '#5D4B34', fontWeight: 500 }}>
              ETA: {etaText}
            </Typography>
          </Stack>

          {helper && !compact && (
            <Typography
              sx={{
                mt: 0.4,
                textAlign: 'center',
                fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                color: '#6A5842',
                fontSize: '0.86rem',
              }}
            >
              {helper}
            </Typography>
          )}
        </Box>
      </Stack>
    </Box>
  );
};

export default ProgressWithETA;
