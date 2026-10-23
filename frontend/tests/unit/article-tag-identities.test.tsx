import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderNoteTags } from '../../src/apis/TagMethods';

afterEach(cleanup);

it('renders two different hierarchy identities with the same numeric id', () => {
    render(<>{renderNoteTags([7], [], [
        {id: 7, level: 1, name: '一级测试', color: '#1677ff'},
        {id: 7, level: 2, name: '二级测试', color: '#ff0000'},
    ])}</>);
    expect(screen.getByText('一级测试')).toBeTruthy();
    expect(screen.getByText('二级测试')).toBeTruthy();
});

it('does not resurrect legacy ids when the authoritative reference list is empty', () => {
    const tree = [{tagKey: 7, title: '旧标签', color: '#1677ff'}];
    const {container} = render(<>{renderNoteTags([7], tree, [])}</>);
    expect(container.textContent).toBe('');
});
