import atlas from './assets/lanterns.webp';

/** Three equal cells in one transparent atlas; every instance shares the same decoded texture. */
export function LanternArt({ variant }: { variant: number }) {
    const cell = variant === 1 || variant === 2 ? variant : 0;
    return <span aria-hidden="true" className="rz-lamp-art"
        style={{ backgroundImage: `url(${atlas})`, backgroundPosition: `${cell * 50}% center` }} />;
}
