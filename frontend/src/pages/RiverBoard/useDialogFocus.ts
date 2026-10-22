import { useEffect, useRef } from 'react';

/** Keep keyboard navigation inside the current dialog; restore the opener on close. */
export function useDialogFocus(dialogKey: string, close: () => void) {
    const latestClose = useRef(close);
    useEffect(() => { latestClose.current = close; });
    useEffect(() => {
        if (!dialogKey) return;
        const dialog = document.querySelector<HTMLElement>('.rz-cinematic [role="dialog"]');
        if (!dialog) return;
        const opener = document.activeElement as HTMLElement | null;
        const shell = document.querySelector<HTMLElement>('.rz-cinematic .rz-ui');
        const lights = document.querySelector<HTMLElement>('.rz-cinematic .rz-lanterns');
        if (shell) shell.inert = true;
        if (lights) lights.inert = true;
        dialog.tabIndex = -1;
        const targets = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]'))
            .filter(el => el.getClientRects().length > 0);
        (targets()[0] || dialog).focus({ preventScroll: true });
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); latestClose.current();
            } else if (event.key === 'Tab') {
                const nodes = targets();
                const first = nodes[0] || dialog, last = nodes[nodes.length - 1] || dialog;
                if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
                    event.preventDefault(); first.focus();
                }
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            if (shell) shell.inert = false;
            if (lights) lights.inert = false;
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        };
    }, [dialogKey]);
}
