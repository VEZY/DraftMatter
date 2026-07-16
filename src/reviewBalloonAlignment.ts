export interface ReviewBalloonMeasurement {
  id: string
  naturalTop: number
  height: number
  targetTop?: number
}

export interface ReviewBalloonPlacement {
  id: string
  aligned: boolean
  top: number
  translateY: number
}

export interface ReviewBalloonLayout {
  placements: ReviewBalloonPlacement[]
  bottom: number
}

/**
 * Places review balloons beside their document lines without allowing cards to
 * overlap. Unplaced reviews stay in ordinary queue order after the last card.
 */
export function alignReviewBalloons(
  measurements: ReviewBalloonMeasurement[],
  gap = 11,
): ReviewBalloonLayout {
  let previousBottom = 0
  let previousTranslate = 0

  const placements = measurements.map((measurement, index) => {
    const collisionTop = index === 0 ? measurement.naturalTop : previousBottom + gap
    const requestedTop = measurement.targetTop === undefined
      ? measurement.naturalTop + previousTranslate
      : measurement.targetTop
    const top = Math.max(measurement.naturalTop, collisionTop, requestedTop)
    const translateY = top - measurement.naturalTop

    previousBottom = top + Math.max(0, measurement.height)
    previousTranslate = Math.max(previousTranslate, translateY)

    return {
      id: measurement.id,
      aligned: measurement.targetTop !== undefined,
      top,
      translateY,
    }
  })

  return {
    placements,
    bottom: previousBottom,
  }
}
