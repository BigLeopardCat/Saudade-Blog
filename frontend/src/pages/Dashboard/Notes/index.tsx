import './index.sass'
import {Breadcrumb, ConfigProvider, Menu, MenuProps} from "antd";
import {AppstoreOutlined} from "@ant-design/icons";
import { HomeOutlined, UserOutlined } from '@ant-design/icons';
import {Link, Outlet, useLocation, useNavigate} from "react-router-dom";
import React, {useContext} from "react";
import MainContext from "../../../components/conText.tsx";

//Menu数据
type MenuItem = Required<MenuProps>['items'][number];
function getItem(
    label: React.ReactNode,
    key?: React.Key | null,
    icon?: React.ReactNode,
    children?: MenuItem[],
    to?: string
): MenuItem {
    return {
        key,
        icon,
        children,
        label,
        to
    } as MenuItem;
}
const items: MenuItem[] = [
    getItem('导航', 'sub2', <AppstoreOutlined />, [
        getItem('全部文章', '1','',undefined,' '),
        getItem('编辑文章', '2','',undefined,'newnote'),
        getItem('全部分类', '3','',undefined,'allcategorize'),
        getItem('全部标签', '4','',undefined,'alltags'),
    ]),
];

const NOTE_PAGES: Record<string, { key: string; label: string }> = {
    '':            { key: '1', label: '全部文章' },
    'newnote':     { key: '2', label: '编辑文章' },
    'allcategorize': { key: '3', label: '全部分类' },
    'alltags':     { key: '4', label: '全部标签' },
}

const Notes = () => {
    //hooks区域
    const navigate = useNavigate()
    const { pathname } = useLocation()
    //夜间模式判断
    const isDark = useContext(MainContext) === 'true'

    const noteSeg = pathname.replace(/^\/dashboard\/notes\/?/, '').split('/')[0]
    const notePage = NOTE_PAGES[noteSeg]

    // 回调函数区域
    const ClickMenu: MenuProps['onClick'] = (e) => {
        // @ts-ignore
        navigate(e.item.props.to)
    };

    return <>
        <ConfigProvider
            theme={{
                components: {
                    Menu: {
                        itemSelectedColor: isDark?'rgba(243,243,243,0.88)':'rgba(0,0,0,0.88)',
                        itemSelectedBg: isDark?'rgba(0,0,0,0.58)':'#e6f4ff'
                    },
                    Breadcrumb: {
                        itemColor: isDark?'rgba(243,243,243,0.88)':'rgba(0,0,0,0.88)',
                        lastItemColor: isDark?'rgba(243,243,243,0.88)':'rgba(0,0,0,0.88)',
                        linkColor: isDark?'rgba(243,243,243,0.88)':'rgba(0,0,0,0.88)',
                        separatorColor: isDark?'rgba(243,243,243,0.45)':'rgba(0,0,0,0.45)',
                    }
                },
            }}
        >
            <div className="header">

                <Menu
                    style={{ width: 125 }}
                    mode="vertical"
                    items={items}
                    className="twoMenu"
                    onClick={ClickMenu}
                    // 受控：按路径派生选中项；写死 `defaultSelectedKeys` 只认初次挂载，
                    // 进哪个子页都只有「全部文章」亮。
                    selectedKeys={notePage ? [notePage.key] : []}
                    // 必须跟随主题；写死 `theme="light"` 时，壳上挂了 darkAlgorithm 之后
                    // 这块左侧子菜单仍会是一块浅色砖（Menu 的 theme 优先于 token）。
                    theme={isDark ? 'dark' : 'light'}
                />
                <Breadcrumb style={{ marginLeft: 10 }}>
                    <Breadcrumb.Item>
                        <Link to="/dashboard">
                            <HomeOutlined />
                        </Link>
                    </Breadcrumb.Item>
                    <Breadcrumb.Item>
                        <Link to="/dashboard/notes">
                            <UserOutlined />
                            <span>笔记</span>
                        </Link>
                    </Breadcrumb.Item>
                    <Breadcrumb.Item>
                        {notePage ? notePage.label : '未知页面'}
                    </Breadcrumb.Item>
                </Breadcrumb>
            </div>
        </ConfigProvider>

        <Outlet />
    </>
}

export default Notes