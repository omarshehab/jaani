import React, { useState, useEffect, useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import slogansData from '../data/slogans.json';

const SloganCarousel = () => {
  const [index, setIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const slogans = useMemo(() => slogansData.slogans || [], []);

  // 3-second carousel with fade transitions
  useEffect(() => {
    if (!slogans || slogans.length === 0) return;

    const interval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setIndex((prevIndex) => (prevIndex + 1) % slogans.length);
        setIsVisible(true);
      }, 500); // 500ms fade out
    }, 3000); // 3 seconds per slogan

    return () => clearInterval(interval);
  }, [slogans]);

  if (!slogans || slogans.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes fadeInSlogan {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOutSlogan {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .slogan-enter {
          animation: fadeInSlogan 0.8s ease-in forwards;
        }
        .slogan-exit {
          animation: fadeOutSlogan 0.8s ease-out forwards;
        }
      `}</style>
      <Box
        sx={{
          height: '2.5rem',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Typography
          variant="body1"
          className={isVisible ? 'slogan-enter' : 'slogan-exit'}
          sx={{
            fontStyle: 'normal',
            fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
            fontSize: { xs: '1.05rem', sm: '1.2rem', md: '1.35rem' },
            fontWeight: 500,
            color: '#4D4030',
            textAlign: 'center',
            px: 2,
            width: '100%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {slogans[index]}
        </Typography>
      </Box>
    </>
  );
};

export default SloganCarousel;
