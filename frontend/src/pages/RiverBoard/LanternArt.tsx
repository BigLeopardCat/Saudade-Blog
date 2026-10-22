import { useId } from 'react';
import atlas from './assets/lanterns.webp';

/** Shared traditional paper-and-bamboo atlas; live fire is composited inside each vessel. */
export function LanternArt({ variant, seed = variant }: { variant: number; seed?: number }) {
    const cell = variant === 1 || variant === 2 ? variant : 0;
    const gradient = useId().replace(/:/g, '');
    const open = cell === 0;
    return <span aria-hidden="true" className="rz-lamp-art"
        style={{ backgroundImage: `url(${atlas})`, backgroundPosition: `${cell * 50}% center`, position: 'relative' }}>
        <span className="rz-live-ember" style={{ position: 'absolute', pointerEvents: 'none',
            left: open ? '28%' : '20%', top: open ? '29%' : '31%', width: open ? '44%' : '60%', height: '47%',
            background: 'radial-gradient(ellipse, #ffefb99c 0%, #ffbf633d 34%, #f5962800 71%)',
            opacity: 'var(--rz-flicker, .8)', transform: 'scale(var(--rz-flicker, .9))', mixBlendMode: 'screen' }} />
        <svg className="rz-live-flame" viewBox="0 0 40 64" style={{ position: 'absolute', pointerEvents: 'none',
            left: open ? '43%' : '41%', top: open ? '38%' : '48%', width: open ? '14%' : '18%', height: open ? '19%' : '25%',
            opacity: open ? 'var(--rz-flicker, .85)' : 'calc(var(--rz-flicker, .85) * .45)',
            transformOrigin: '50% 95%', transform: 'skewX(var(--rz-flame-lean, 0deg)) scaleY(calc(.74 + var(--rz-flicker, .85) * .32))',
            animationDelay: `${-(seed * 0.618 % 1) * 4}s`, overflow: 'visible', mixBlendMode: 'screen' }}>
            <defs><linearGradient id={gradient} x1="0" y1="1" x2=".1" y2="0">
                <stop offset="0" stopColor="#ff862b" /><stop offset=".45" stopColor="#ffd273" /><stop offset="1" stopColor="#fff3cc" />
            </linearGradient></defs>
            <path className="rz-flame-tip" fill={`url(#${gradient})`} d="M20 62C-4 57 7 32 17 20 22 13 23 7 22 0 41 25 42 53 20 62Z" />
            <path className="rz-flame-core" fill="#fff8d6" d="M20 60C9 54 17 41 22 31 22 44 34 53 20 60Z" />
        </svg>
    </span>;
}
