export function transpose<T>(matrix: T[][]): T[][] {
    return matrix[0].map((_, index) => matrix.map((row) => row[index]));
}
