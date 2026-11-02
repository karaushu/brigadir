import { create } from 'zustand';
import type { BoardPR } from './ProjectPRs';

/**
 * spec/sidebar#section-rail: a PR row of the sidebar's Pull requests section opens its review over the board (spec/projects-and-board#pr-mode). The board
 * on screen takes the request; the row stays selected while that review is open.
 */
export const usePRSectionReview = create<{ item: BoardPR | null; seq: number }>(() => ({
	item: null,
	seq: 0,
}));
export const requestPRReview = (item: BoardPR) =>
	usePRSectionReview.setState((state) => ({ item, seq: state.seq + 1 }));
export const clearPRReview = () => usePRSectionReview.setState({ item: null });
