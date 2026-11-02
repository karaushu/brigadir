import styles from './FilePath.module.css';
export function FilePath({ path, dirty = false }: { path: string; dirty?: boolean }) {
	const index = path.lastIndexOf('/');
	return (
		<span className={styles.path} title={path}>
			{index >= 0 && <span className={styles.directory}>{path.slice(0, index + 1)}</span>}
			<strong>
				{path.slice(index + 1)}
				{dirty ? ' •' : ''}
			</strong>
		</span>
	);
}
